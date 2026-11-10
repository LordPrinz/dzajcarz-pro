import {
  type BotModule,
  type CronScheduler,
  defineCommand,
  defineSubcommand,
  firesAt,
  type GuildTimeZones,
  type Logger,
  MANAGE_GUILD,
  requireGuild,
  UserError,
} from "@dzajcarz/core";

/** A song the schedule may play. `name` is the fixed key stored in settings; `title` is what members read. */
export interface ScheduledSong {
  name: string;
  title: string;
}

/** Where each server's choices are stored. */
export interface ScheduleSettings {
  /** The song the server chose, or null for the default. */
  getSong(guildId: string): Promise<string | null>;
  setSong(guildId: string, song: string): Promise<void>;
  /** Back to the default song; false when none was chosen. */
  clearSong(guildId: string): Promise<boolean>;
  listExcluded(guildId: string): Promise<string[]>;
  /** False when the channel was already excluded. */
  addExcluded(guildId: string, channelId: string): Promise<boolean>;
  /** False when the channel was not excluded. */
  removeExcluded(guildId: string, channelId: string): Promise<boolean>;
}

export interface VoiceCrowd {
  channelId: string;
  /** People in the channel, bots excluded. */
  humans: number;
}

/** Who sits where, from the gateway's voice states. */
export interface ScheduleVoice {
  /** Servers the bot is in. */
  guildIds(): readonly string[];
  /** The voice channels the bot may join and speak in, with their listeners. */
  crowds(guildId: string): Promise<VoiceCrowd[]>;
  /** The server's AFK channel, or null; the song never plays there. */
  afkChannelId(guildId: string): string | null;
  /** Whether the channel is a voice channel of this server. */
  isVoiceChannelOf(guildId: string, channelId: string): Promise<boolean>;
}

/** `busy`: a member's music started before the song could take over, so the song was not played. */
export type ScheduledPlayResult = { status: "busy" } | { status: "played"; queued: boolean };

/**
 * Plays the schedule's songs. The song is always a `ScheduledSong.name` from the fixed list: the adapter
 * maps it to a file, and nothing a member typed ever reaches it.
 */
export interface ScheduledSongPlayer {
  /** False while no audio node is connected. */
  available(): boolean;
  /** Whether the server has music playing or queued right now (paused counts). */
  isPlaying(guildId: string): boolean;
  /**
   * Joins the voice channel (moving a lingering idle player there) and plays the song, without a now
   * playing panel. Resolves `busy` at once when members' music got there first; otherwise when the song
   * is over, with `queued` telling whether the server's queue still holds tracks by then.
   */
  play(guildId: string, voiceChannelId: string, song: string): Promise<ScheduledPlayResult>;
  leave(guildId: string): Promise<void>;
}

export interface ScheduleModuleDeps {
  settings: ScheduleSettings;
  voice: ScheduleVoice;
  player: ScheduledSongPlayer;
  cron: CronScheduler;
  /** Whether the module is switched on for the channel (the module toggles). */
  moduleEnabled: (guildId: string, channelId: string, module: string) => Promise<boolean>;
  logger: Logger;
  /** The fixed song list; the first entry is the default. */
  songs: readonly [ScheduledSong, ...ScheduledSong[]];
  /** Five-field cron expression, read on each server's own clock. */
  expression: string;
  /** The zone of each server (`/timezone`). */
  timeZones: GuildTimeZones;
  now: () => Date;
}

/** How early the minute tick may fire and still count as the coming minute. */
const EARLY_TICK_MS = 5_000;

const MODULE_NAME = "schedule";
/** The `/schedule song` value that goes back to the default song; no listed song may use it. */
const RESET = "reset";

/** The most crowded channel; a tie goes to the older channel (smaller snowflake) so the pick is stable. */
export function pickChannel(crowds: readonly VoiceCrowd[]): VoiceCrowd | null {
  let best: VoiceCrowd | null = null;
  for (const crowd of crowds) {
    if (crowd.humans < 1) continue;
    if (
      best === null ||
      crowd.humans > best.humans ||
      (crowd.humans === best.humans && BigInt(crowd.channelId) < BigInt(best.channelId))
    ) {
      best = crowd;
    }
  }
  return best;
}

export function createScheduleModule({
  settings,
  voice,
  player,
  cron,
  moduleEnabled,
  logger,
  songs,
  expression,
  timeZones,
  now,
}: ScheduleModuleDeps): BotModule {
  if (songs.some((song) => song.name === RESET)) {
    throw new Error(`"${RESET}" is reserved for /schedule song and cannot name a song`);
  }
  const defaultSong = songs[0];
  const songByName = new Map(songs.map((song) => [song.name, song]));
  /** Servers whose song is on right now, so an overlapping run cannot start a second one. */
  const running = new Set<string>();

  async function chosenSong(guildId: string): Promise<ScheduledSong> {
    const name = await settings.getSong(guildId);
    return (name !== null ? songByName.get(name) : undefined) ?? defaultSong;
  }

  /** Plays the song in one server's busiest allowed channel. Does nothing when there is no such channel. */
  async function playIn(guildId: string): Promise<void> {
    if (running.has(guildId) || player.isPlaying(guildId)) return;
    // Claimed before the first await, so a run that overlaps this one sees the server as taken.
    running.add(guildId);
    try {
      const [excluded, crowds] = await Promise.all([
        settings.listExcluded(guildId),
        voice.crowds(guildId),
      ]);
      const afk = voice.afkChannelId(guildId);
      const allowed = crowds.filter(
        (crowd) =>
          crowd.humans > 0 && crowd.channelId !== afk && !excluded.includes(crowd.channelId),
      );
      // The toggle is per channel, so a switched-off channel is as good as an excluded one.
      const enabled: VoiceCrowd[] = [];
      for (const crowd of allowed) {
        if (await moduleEnabled(guildId, crowd.channelId, MODULE_NAME)) enabled.push(crowd);
      }
      const target = pickChannel(enabled);
      if (!target) return;

      const song = await chosenSong(guildId);
      logger.info("Playing the scheduled song", {
        guildId,
        channelId: target.channelId,
        song: song.name,
      });
      const result = await player.play(guildId, target.channelId, song.name);
      if (result.status === "busy") {
        logger.info("Skipping the scheduled song: music started meanwhile", { guildId });
        return;
      }
      // Something else was queued meanwhile: it is the music module's now, and so is leaving.
      if (!result.queued) await player.leave(guildId);
    } finally {
      running.delete(guildId);
    }
  }

  /** Every minute: plays in each server whose own clock reads a time the expression fires at. */
  async function tick(): Promise<void> {
    // A tick up to 5 s early belongs to the coming minute; a late one keeps its own.
    const minute = new Date(Math.floor((now().getTime() + EARLY_TICK_MS) / 60_000) * 60_000);
    // Most minutes nobody sits in voice anywhere, so the voice cache (no I/O) filters first and only those
    // servers have their zone looked up; a minute the cron does not fire on then costs nothing further.
    const occupied: string[] = [];
    await Promise.all(
      voice.guildIds().map(async (guildId) => {
        const crowds = await voice.crowds(guildId);
        if (crowds.some((crowd) => crowd.humans > 0)) occupied.push(guildId);
      }),
    );
    const firesIn = new Map<string, boolean>();
    const zones = await Promise.all(occupied.map((guildId) => timeZones.of(guildId)));
    const due = occupied.filter((_guildId, index) => {
      const zone = zones[index] as string;
      let fires = firesIn.get(zone);
      if (fires === undefined) {
        fires = firesAt(expression, minute, zone);
        firesIn.set(zone, fires);
      }
      return fires;
    });
    if (due.length === 0) return;
    if (!player.available()) {
      logger.warn("Skipping the scheduled song: the audio node is unavailable");
      return;
    }
    // Not awaited: `play` resolves only when the song is over (never, while it is paused), and the cron
    // schedules the next tick only after this one settles, so waiting would hold up every server. `running`
    // keeps a later tick from starting a second song in a server that is still playing.
    for (const guildId of due) {
      playIn(guildId).catch((error) => {
        logger.warn("The scheduled song failed", { guildId, error });
      });
    }
  }

  async function safeTick(): Promise<void> {
    try {
      await tick();
    } catch (error) {
      logger.error("Scheduled song tick failed", { error });
    }
  }

  // Every minute of UTC is every minute of every zone; each server's clock decides whether it plays.
  const stop = cron.every("* * * * *", "UTC", safeTick);

  const channelLine = (channelId: string) => `<#${channelId}>`;

  const schedule = defineCommand({
    name: "schedule",
    description: "Piosenka o stałych porach na najbardziej zaludnionym kanale głosowym",
    permissions: MANAGE_GUILD,
    subcommands: {
      list: defineSubcommand({
        description: "Pokazuje piosenkę, godziny i wykluczone kanały",
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          const [song, excluded] = await Promise.all([
            chosenSong(guildId),
            settings.listExcluded(guildId),
          ]);
          const lines = [
            `Piosenka: **${song.title}**`,
            `Harmonogram: \`${expression}\` (${await timeZones.of(guildId)}, zmienisz przez /timezone)`,
            excluded.length > 0
              ? `Wykluczone kanały: ${excluded.map(channelLine).join(", ")}`
              : "Brak wykluczonych kanałów.",
          ];
          await ctx.reply({ content: lines.join("\n"), ephemeral: true });
        },
      }),
      exclude: defineSubcommand({
        description: "Wyklucza kanał głosowy z odtwarzania",
        options: {
          channel: { type: "channel", description: "Kanał głosowy", required: true },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          const { channel } = ctx.args;
          if (!(await voice.isVoiceChannelOf(guildId, channel))) {
            throw new UserError("Wybierz kanał głosowy z tego serwera.");
          }
          const added = await settings.addExcluded(guildId, channel);
          await ctx.reply({
            content: added
              ? `Kanał ${channelLine(channel)} jest wykluczony.`
              : `Kanał ${channelLine(channel)} był już wykluczony.`,
            ephemeral: true,
          });
        },
      }),
      include: defineSubcommand({
        description: "Przywraca wykluczony kanał głosowy",
        options: {
          channel: { type: "channel", description: "Kanał głosowy", required: true },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          const { channel } = ctx.args;
          // No channel-type check: a deleted channel must still be removable from the list.
          const removed = await settings.removeExcluded(guildId, channel);
          await ctx.reply({
            content: removed
              ? `Kanał ${channelLine(channel)} nie jest już wykluczony.`
              : `Kanał ${channelLine(channel)} nie był wykluczony.`,
            ephemeral: true,
          });
        },
      }),
      song: defineSubcommand({
        description: "Wybiera piosenkę (bez nazwy: pokazuje dostępne, reset: domyślna)",
        options: {
          name: {
            type: "string",
            description: "Nazwa piosenki",
            required: false,
            choices: [
              ...songs.map((song) => ({ name: song.title, value: song.name })),
              { name: `Domyślna (${defaultSong.title})`, value: RESET },
            ],
          },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          const name = ctx.args.name?.trim();
          if (!name) {
            const current = await chosenSong(guildId);
            const available = songs.map((song) => `\`${song.name}\` (${song.title})`).join(", ");
            await ctx.reply({
              content: `Teraz: **${current.title}**. Dostępne: ${available}. \`${RESET}\` przywraca domyślną.`,
              ephemeral: true,
            });
            return;
          }
          if (name === RESET) {
            const cleared = await settings.clearSong(guildId);
            await ctx.reply({
              content: cleared
                ? `Przywrócono domyślną piosenkę: **${defaultSong.title}**.`
                : `Już gra domyślna piosenka: **${defaultSong.title}**.`,
              ephemeral: true,
            });
            return;
          }
          const song = songByName.get(name);
          if (!song) {
            throw new UserError(
              `Nie znam piosenki \`${name}\`. Dostępne: ${songs.map((s) => `\`${s.name}\``).join(", ")}.`,
            );
          }
          await settings.setSong(guildId, song.name);
          await ctx.reply({ content: `Wybrana piosenka: **${song.title}**.`, ephemeral: true });
        },
      }),
    },
  });

  return {
    name: MODULE_NAME,
    commands: [schedule],
    dispose: stop,
  };
}

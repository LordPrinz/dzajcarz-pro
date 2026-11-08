import {
  type BotModule,
  type ButtonSpec,
  type CommandContext,
  type ComponentContext,
  createComponentStateStore,
  createPaginator,
  defineButton,
  defineCommand,
  defineEvent,
  defineSelect,
  type Logger,
  PUBLIC_OWNER,
  type Scheduler,
  type StateStorage,
  UserError,
} from "@dzajcarz/core";
import { escapeMarkdown, formatDuration, parseQuery, truncate } from "./format.ts";
import { PANEL_COLOR, panelMessage, queueLine, trackEmbed, tracksWord } from "./panel.ts";
import type {
  MusicPlayer,
  MusicQuery,
  MusicTrack,
  PanelMessages,
  PlayerState,
  VoiceChannels,
} from "./ports.ts";

export * from "./ports.ts";

export interface MusicModuleDeps {
  player: MusicPlayer;
  voice: VoiceChannels;
  panels: PanelMessages;
  /** Runs the idle timeout. */
  scheduler: Scheduler;
  /** Holds `/search` results until the member picks one (ADR 6 component state). */
  stateStorage: StateStorage;
  logger: Logger;
  /** How long the bot stays with an empty queue or an empty channel. */
  idleMs?: number;
}

const MODULE = "music";
export const IDLE_MS = 3 * 60_000;
/** A playlist adds at most this many tracks. */
export const MAX_PLAYLIST_TRACKS = 100;
/** Current track plus everything queued. */
export const MAX_QUEUE_LENGTH = 500;
/** Discord allows 25 options; ten results are enough to choose from. */
const MAX_SEARCH_RESULTS = 10;
const QUEUE_PAGE_SIZE = 10;

export const UNAVAILABLE = "Odtwarzacz muzyki jest teraz niedostępny.";
export const NOT_IN_VOICE = "Najpierw wejdź na kanał głosowy.";
export const NOTHING_PLAYING = "Nic teraz nie gra.";
export const UNSUPPORTED_LINK =
  "Obsługuję tylko linki z YouTube, SoundCloud, Bandcamp, Twitch i Vimeo.";
export const trackFailedText = (title: string) =>
  `Nie udało się odtworzyć **${escapeMarkdown(title)}**, gram dalej.`;
export const otherChannel = (channelId: string) =>
  `Musisz być na kanale <#${channelId}>, na którym gram.`;

interface PendingSearch {
  tracks: MusicTrack[];
}

export function createMusicModule({
  player,
  voice,
  panels,
  scheduler,
  stateStorage,
  logger,
  idleMs = IDLE_MS,
}: MusicModuleDeps): BotModule {
  const searches = createComponentStateStore(stateStorage);

  function guildOf(ctx: Pick<CommandContext, "guildId">): string {
    // Commands are guild-only by default and the components declare guildOnly, so this never fires.
    if (ctx.guildId === null) throw new UserError("Muzyka działa tylko na serwerze.");
    return ctx.guildId;
  }

  /** The member's input as a query; a link to another site is refused here. */
  function queryOf(input: string, emptyText: string): MusicQuery {
    const query = parseQuery(input);
    if (!query) throw new UserError(emptyText);
    if (query.kind === "unsupported") throw new UserError(UNSUPPORTED_LINK);
    return query;
  }

  /**
   * The caller must be in a voice channel, and in the bot's once the bot plays in the guild. Returns
   * the caller's channel and the guild's player, if any. `needsNode: false` lets a command that only
   * tears down (stop) through while the node is away.
   */
  async function requireListener(guildId: string, userId: string, needsNode = true) {
    if (needsNode && !player.available()) throw new UserError(UNAVAILABLE);
    const channelId = await voice.channelOf(guildId, userId);
    if (channelId === null) throw new UserError(NOT_IN_VOICE);
    const state = player.state(guildId);
    if (state && state.voiceChannelId !== channelId) {
      throw new UserError(otherChannel(state.voiceChannelId));
    }
    return { channelId, state };
  }

  /** Like `requireListener`, for controls: there must be something to control. */
  async function requireControl(
    guildId: string,
    userId: string,
    needsNode = true,
  ): Promise<PlayerState> {
    if (needsNode && !player.available()) throw new UserError(UNAVAILABLE);
    if (!player.state(guildId)) throw new UserError(NOTHING_PLAYING);
    const { state } = await requireListener(guildId, userId, needsNode);
    if (!state) throw new UserError(NOTHING_PLAYING);
    return state;
  }

  /** Additions run one at a time per guild: two quick `/play`s must not both join or both "start". */
  const additions = new Map<string, Promise<unknown>>();

  function oneAtATime<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    const result = (additions.get(guildId) ?? Promise.resolve()).then(task);
    const settled = result.catch(() => {});
    additions.set(guildId, settled);
    void settled.then(() => {
      if (additions.get(guildId) === settled) additions.delete(guildId);
    });
    return result;
  }

  /**
   * Adds tracks for a member, joining first when the bot is not in voice. The voice rules, the queue cap
   * and the "starts now" answer are all decided from the state inside the per-guild chain, so they see
   * what an addition just before did. Returns what was accepted and whether playback starts with it.
   */
  function addTracks(
    guildId: string,
    userId: string,
    textChannelId: string,
    tracks: readonly MusicTrack[],
  ) {
    return oneAtATime(guildId, async () => {
      // The caller may have moved since the command started, or another addition made the bot join.
      const { channelId, state } = await requireListener(guildId, userId);
      const queued = state ? state.upcoming.length + (state.current ? 1 : 0) : 0;
      const room = MAX_QUEUE_LENGTH - queued;
      if (room <= 0) throw new UserError(`Kolejka jest pełna (${MAX_QUEUE_LENGTH} utworów).`);
      const accepted = tracks.slice(0, room);
      // Joining a song the bot plays on its own makes this channel the panel's for the tracks to come.
      if (!state || state.current?.byBot) await player.join(guildId, channelId, textChannelId);
      await player.enqueue(guildId, accepted);
      const startsNow = !state?.current;
      // A new track redraws the panel by itself; otherwise only its queue count changed.
      if (!startsNow) void inOrder(guildId, () => showPanel(guildId));
      void reviewIdle(guildId);
      return { accepted, startsNow, position: queued };
    });
  }

  function addedText(track: MusicTrack, startsNow: boolean, position: number): string {
    const title = `**${escapeMarkdown(track.title)}** (${track.isStream ? "na żywo" : formatDuration(track.durationMs)})`;
    return startsNow ? `Gram: ${title}.` : `Dodano do kolejki na miejsce ${position}: ${title}.`;
  }

  const pauseButton = defineButton({
    module: MODULE,
    name: "panel-pause",
    public: true,
    guildOnly: true,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const state = await requireControl(guildId, ctx.user.id);
      if (state.paused) await player.resume(guildId);
      else await player.pause(guildId);
      await updatePanelFromClick(ctx, guildId);
    },
  });

  const skipButton = defineButton({
    module: MODULE,
    name: "panel-skip",
    public: true,
    guildOnly: true,
    async run(ctx) {
      const guildId = guildOf(ctx);
      // Answer the click first: Discord gives three seconds, and the skip waits for the node.
      await ctx.defer();
      const state = await requireControl(guildId, ctx.user.id);
      if (!state.current) throw new UserError(NOTHING_PLAYING);
      // The next trackStart (or queueEnd) redraws the panel.
      await player.skip(guildId, state.current.id);
    },
  });

  const stopButton = defineButton({
    module: MODULE,
    name: "panel-stop",
    public: true,
    guildOnly: true,
    async run(ctx) {
      const guildId = guildOf(ctx);
      // Acknowledged before playerDestroyed deletes the panel this button sits on.
      await ctx.defer();
      await requireControl(guildId, ctx.user.id, false);
      // playerDestroyed removes the panel.
      await player.leave(guildId);
    },
  });

  const queueButton = defineButton({
    module: MODULE,
    name: "panel-queue",
    public: true,
    guildOnly: true,
    async run(ctx) {
      await ctx.reply({ ...(await queuePages.first(ctx)), ephemeral: true });
    },
  });

  const buttons = {
    pause: (paused: boolean): ButtonSpec => ({
      type: "button",
      customId: pauseButton.customId(PUBLIC_OWNER),
      label: paused ? "Wznów" : "Pauza",
      emoji: paused ? "▶️" : "⏸️",
      style: "primary",
    }),
    skip: {
      type: "button",
      customId: skipButton.customId(PUBLIC_OWNER),
      label: "Dalej",
      emoji: "⏭️",
      style: "secondary",
    },
    stop: {
      type: "button",
      customId: stopButton.customId(PUBLIC_OWNER),
      label: "Stop",
      emoji: "⏹️",
      style: "danger",
    },
    queue: {
      type: "button",
      customId: queueButton.customId(PUBLIC_OWNER),
      label: "Kolejka",
      emoji: "📜",
      style: "secondary",
    },
  } satisfies Parameters<typeof panelMessage>[1];

  /** The posted panel of each guild. */
  const posted = new Map<string, { channelId: string; messageId: string }>();
  /** Panel work runs one at a time per guild, so two quick track changes never post two panels. */
  const panelWork = new Map<string, Promise<void>>();

  function inOrder(guildId: string, task: () => Promise<void>): Promise<void> {
    const next = (panelWork.get(guildId) ?? Promise.resolve()).then(task).catch((error) => {
      logger.warn("Now playing panel update failed", { guildId, error });
    });
    panelWork.set(guildId, next);
    void next.then(() => {
      if (panelWork.get(guildId) === next) panelWork.delete(guildId);
    });
    return next;
  }

  async function showPanel(guildId: string): Promise<void> {
    const state = player.state(guildId);
    const message = state && panelMessage(state, buttons);
    if (!state || !message) return;
    const existing = posted.get(guildId);
    if (existing?.channelId === state.textChannelId) {
      let edited: "edited" | "gone";
      try {
        edited = await panels.edit(existing.channelId, existing.messageId, message);
      } catch (error) {
        // Discord refused for another reason (rate limit, outage): keep the panel, the next change retries.
        logger.warn("Editing the now playing panel failed", { guildId, error });
        return;
      }
      if (edited === "edited") return;
      // Someone deleted the panel or its channel: post a fresh one.
    } else if (existing) {
      await panels.delete(existing.channelId, existing.messageId).catch(() => {});
    }
    posted.delete(guildId);
    const messageId = await panels.post(state.textChannelId, message);
    posted.set(guildId, { channelId: state.textChannelId, messageId });
  }

  async function removePanel(guildId: string): Promise<void> {
    const existing = posted.get(guildId);
    if (!existing) return;
    posted.delete(guildId);
    await panels.delete(existing.channelId, existing.messageId);
  }

  /** Pause and resume redraw the panel; a click on the panel edits it through the interaction. */
  async function updatePanelFromClick(ctx: ComponentContext, guildId: string): Promise<void> {
    const state = player.state(guildId);
    const message = state && panelMessage(state, buttons);
    if (message) await ctx.update(message);
  }

  const idleTimers = new Map<string, () => void>();

  function cancelIdle(guildId: string): void {
    idleTimers.get(guildId)?.();
    idleTimers.delete(guildId);
  }

  /** Nothing playing, or nobody but bots listening. */
  async function isIdle(guildId: string): Promise<boolean | null> {
    const state = player.state(guildId);
    if (!state) return null;
    if (state.current === null) return true;
    return (await voice.humanCount(guildId, state.voiceChannelId)) === 0;
  }

  /** Arms the leave timer when the guild's player became idle, disarms it when it is busy again. */
  async function reviewIdle(guildId: string): Promise<void> {
    try {
      const idle = await isIdle(guildId);
      if (!idle) {
        cancelIdle(guildId);
        return;
      }
      if (idleTimers.has(guildId)) return;
      const cancel = scheduler.after(idleMs, () => {
        idleTimers.delete(guildId);
        void leaveIfIdle(guildId);
      });
      idleTimers.set(guildId, cancel);
    } catch (error) {
      logger.warn("Checking whether the player is idle failed", { guildId, error });
    }
  }

  async function leaveIfIdle(guildId: string): Promise<void> {
    try {
      if (!(await isIdle(guildId))) return;
      logger.info("Leaving an idle voice channel", { guildId });
      await player.leave(guildId);
    } catch (error) {
      logger.warn("Leaving an idle voice channel failed", { guildId, error });
    }
  }

  const unsubscribe = player.subscribe({
    trackStart(guildId) {
      void inOrder(guildId, () => showPanel(guildId));
      void reviewIdle(guildId);
    },
    queueEnd(guildId) {
      void inOrder(guildId, () => removePanel(guildId));
      void reviewIdle(guildId);
    },
    playerDestroyed(guildId) {
      cancelIdle(guildId);
      void inOrder(guildId, () => removePanel(guildId));
    },
    trackFailed(guildId, track) {
      if (track.byBot) return;
      const channelId = player.state(guildId)?.textChannelId;
      if (!channelId) return;
      panels.post(channelId, { content: trackFailedText(track.title) }).catch((error: unknown) => {
        logger.warn("Posting a failed track note failed", { guildId, error });
      });
    },
  });

  const voiceChange = defineEvent({
    name: "music-idle",
    event: "voiceStateUpdate",
    // Leaving an empty channel is cleanup: it must happen even where the module is switched off.
    alwaysRun: true,
    async run(_oldState, newState) {
      const guildId = newState.guild.id;
      if (player.state(guildId)) await reviewIdle(guildId);
    },
  });

  const guildGone = defineEvent({
    name: "music-guild-gone",
    event: "guildDelete",
    // The bot was removed from the server (or it went unavailable): nothing is left to play into.
    alwaysRun: true,
    async run(guild) {
      if (player.state(guild.id)) await player.leave(guild.id);
    },
  });

  const queuePages = createPaginator({
    module: MODULE,
    name: "queue-page",
    guildOnly: true,
    render({ page, viewer }) {
      const state = viewer.guildId === null ? null : player.state(viewer.guildId);
      if (!state?.current) return { content: NOTHING_PLAYING, pageCount: 1 };
      const pageCount = Math.max(1, Math.ceil(state.upcoming.length / QUEUE_PAGE_SIZE));
      const start = page * QUEUE_PAGE_SIZE;
      const lines = state.upcoming
        .slice(start, start + QUEUE_PAGE_SIZE)
        .map((track, index) => queueLine(start + index + 1, track));
      const total = state.upcoming.reduce((sum, track) => sum + track.durationMs, 0);
      return {
        embeds: [
          {
            title: "Kolejka",
            color: PANEL_COLOR,
            description: [
              `**Teraz:** ${escapeMarkdown(truncate(state.current.title, 80))}`,
              "",
              lines.length > 0 ? lines.join("\n") : "Nic więcej nie czeka w kolejce.",
            ].join("\n"),
            footer:
              state.upcoming.length === 0
                ? undefined
                : `${state.upcoming.length} ${tracksWord(state.upcoming.length)} · ${formatDuration(total)}`,
          },
        ],
        pageCount,
      };
    },
  });

  const queryOption = {
    query: {
      type: "string",
      description: "Link (YouTube, SoundCloud…) albo czego szukać",
      required: true,
      rest: true,
    },
  } as const;

  const play = defineCommand({
    name: "play",
    description: "Odtwarza utwór albo playlistę z linku lub wyszukiwania",
    aliases: ["p"],
    options: queryOption,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const query = queryOf(ctx.args.query, "Podaj link albo czego szukać.");
      await requireListener(guildId, ctx.user.id);
      await ctx.defer();
      const result = await player.search(query, ctx.user.id);
      if (result.kind === "error") {
        logger.info("Loading a track failed", { guildId, query, message: result.message });
        throw new UserError("Nie udało się wczytać tego utworu.");
      }
      if (result.kind === "empty" || result.tracks.length === 0) {
        throw new UserError("Nic nie znaleziono.");
      }
      // A search returns many matches; only the first one is meant.
      const wanted =
        result.kind === "playlist"
          ? result.tracks.slice(0, MAX_PLAYLIST_TRACKS)
          : result.tracks.slice(0, 1);
      // addTracks checks the voice rules again: the search took a while.
      const added = await addTracks(guildId, ctx.user.id, ctx.channelId, wanted);
      if (result.kind !== "playlist") {
        const [track] = added.accepted;
        if (track) await ctx.reply(addedText(track, added.startsNow, added.position));
        return;
      }
      const count = added.accepted.length;
      const skipped = result.tracks.length - count;
      const note =
        skipped === 0
          ? ""
          : ` Pominięto ${skipped} (playlista może dodać do ${MAX_PLAYLIST_TRACKS} utworów, kolejka mieści ${MAX_QUEUE_LENGTH}).`;
      await ctx.reply(
        `Dodano ${count} ${tracksWord(count)} z playlisty **${escapeMarkdown(result.name)}**.${note}`,
      );
    },
  });

  const pick = defineSelect({
    module: MODULE,
    name: "search-pick",
    guildOnly: true,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const { tracks } = await searches.load<PendingSearch>(ctx.state);
      const track = tracks[Number(ctx.values[0])];
      if (!track) throw new UserError("Nie ma takiego wyniku.");
      const added = await addTracks(guildId, ctx.user.id, ctx.channelId, [track]);
      await ctx.update({
        content: addedText(track, added.startsNow, added.position),
        components: [],
      });
    },
  });

  const search = defineCommand({
    name: "search",
    description: "Szuka na YouTube i pozwala wybrać jeden z wyników",
    options: queryOption,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const query = queryOf(ctx.args.query, "Podaj, czego szukać.");
      await requireListener(guildId, ctx.user.id);
      await ctx.defer({ ephemeral: true });
      const result = await player.search(query, ctx.user.id);
      if (result.kind === "error") {
        logger.info("Search failed", { guildId, query, message: result.message });
        throw new UserError("Wyszukiwanie się nie udało.");
      }
      const tracks = result.kind === "empty" ? [] : result.tracks.slice(0, MAX_SEARCH_RESULTS);
      if (tracks.length === 0) throw new UserError("Nic nie znaleziono.");
      const key = await searches.save({ tracks } satisfies PendingSearch);
      await ctx.reply({
        content: "Wybierz utwór:",
        ephemeral: true,
        components: [
          [
            {
              type: "select",
              customId: pick.customId(ctx.user.id, key),
              placeholder: "Wyniki wyszukiwania",
              options: tracks.map((track, index) => ({
                label: truncate(track.title, 100),
                value: String(index),
                description: truncate(
                  `${track.author} · ${track.isStream ? "na żywo" : formatDuration(track.durationMs)}`,
                  100,
                ),
              })),
            },
          ],
        ],
      });
    },
  });

  const queue = defineCommand({
    name: "queue",
    description: "Pokazuje kolejkę utworów",
    async run(ctx) {
      guildOf(ctx);
      await ctx.reply({ ...(await queuePages.first(ctx)), ephemeral: true });
    },
  });

  const skip = defineCommand({
    name: "skip",
    description: "Pomija bieżący utwór",
    async run(ctx) {
      const guildId = guildOf(ctx);
      const state = await requireControl(guildId, ctx.user.id);
      if (!state.current) throw new UserError(NOTHING_PLAYING);
      await player.skip(guildId, state.current.id);
      await ctx.reply(`Pominięto: **${escapeMarkdown(state.current.title)}**.`);
    },
  });

  const stop = defineCommand({
    name: "stop",
    description: "Zatrzymuje muzykę, czyści kolejkę i wychodzi z kanału",
    async run(ctx) {
      const guildId = guildOf(ctx);
      // Works while the node is away too: the bot still leaves voice.
      await requireControl(guildId, ctx.user.id, false);
      await player.leave(guildId);
      await ctx.reply("Zatrzymano muzykę i wyczyszczono kolejkę.");
    },
  });

  const pause = defineCommand({
    name: "pause",
    description: "Wstrzymuje odtwarzanie",
    async run(ctx) {
      const guildId = guildOf(ctx);
      const state = await requireControl(guildId, ctx.user.id);
      if (!state.current) throw new UserError(NOTHING_PLAYING);
      if (state.paused) throw new UserError("Muzyka już jest wstrzymana.");
      await player.pause(guildId);
      void inOrder(guildId, () => showPanel(guildId));
      await ctx.reply("Wstrzymano.");
    },
  });

  const resume = defineCommand({
    name: "resume",
    description: "Wznawia odtwarzanie",
    async run(ctx) {
      const guildId = guildOf(ctx);
      const state = await requireControl(guildId, ctx.user.id);
      if (!state.paused) throw new UserError("Muzyka nie jest wstrzymana.");
      await player.resume(guildId);
      void inOrder(guildId, () => showPanel(guildId));
      await ctx.reply("Wznowiono.");
    },
  });

  const nowPlaying = defineCommand({
    name: "nowplaying",
    description: "Pokazuje, co teraz gra",
    aliases: ["np"],
    async run(ctx) {
      const state = player.state(guildOf(ctx));
      if (!state?.current) throw new UserError(NOTHING_PLAYING);
      const embed = trackEmbed(state.current, state.positionMs, state.upcoming.length);
      await ctx.reply({
        embeds: [
          { ...embed, footer: state.paused ? `Wstrzymane · ${embed.footer}` : embed.footer },
        ],
      });
    },
  });

  return {
    name: MODULE,
    commands: [play, search, queue, skip, stop, pause, resume, nowPlaying],
    events: [voiceChange, guildGone],
    components: [pauseButton, skipButton, stopButton, queueButton, pick, queuePages.button],
    async dispose() {
      unsubscribe();
      for (const cancel of idleTimers.values()) cancel();
      idleTimers.clear();
      // A panel left behind after shutdown would only offer buttons that answer "nothing is playing".
      await Promise.all(
        [...posted.keys()].map((guildId) => inOrder(guildId, () => removePanel(guildId))),
      );
    },
  };
}

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
  escapeMarkdown,
  type LogFields,
  type Logger,
  PUBLIC_OWNER,
  requireGuild,
  type Scheduler,
  type StateStorage,
  truncate,
  UserError,
} from "@dzajcarz/core";
import { formatDuration, httpUrl, parseQuery, parseTime } from "./format.ts";
import {
  FILTER_LABELS,
  LOOP_LABELS,
  PANEL_COLOR,
  panelMessage,
  queueLines,
  settingsLine,
  trackEmbed,
  tracksWord,
} from "./panel.ts";
import type {
  DirectMessages,
  LoopMode,
  MusicFilter,
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
  /** `/save` sends the track this way. */
  directMessages: DirectMessages;
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
/** Failed tracks after the first note within this window are counted and reported once at its end. */
export const FAILED_NOTE_WINDOW_MS = 10_000;
/** Per user, for `/play` and `/search`. */
export const SEARCH_COOLDOWN_MS = 3_000;
/** A playlist adds at most this many tracks. */
export const MAX_PLAYLIST_TRACKS = 100;
/** Current track plus everything queued. */
export const MAX_QUEUE_LENGTH = 500;
/** Discord allows 25 options; ten results are enough to choose from. */
const MAX_SEARCH_RESULTS = 10;
const QUEUE_PAGE_SIZE = 10;
export const MAX_VOLUME = 150;
const LOOP_ORDER: readonly LoopMode[] = ["off", "track", "queue"];

/** What the prefix forms of `/loop` and `/filter` accept, in English and Polish. */
const LOOP_WORDS: Readonly<Record<string, LoopMode>> = {
  off: "off",
  wyłącz: "off",
  wyłączona: "off",
  track: "track",
  utwór: "track",
  queue: "queue",
  kolejka: "queue",
};
const FILTER_WORDS: Readonly<Record<string, MusicFilter>> = {
  bassboost: "bassboost",
  bas: "bassboost",
  nightcore: "nightcore",
  vaporwave: "vaporwave",
  "8d": "8d",
  off: "off",
  wyłącz: "off",
};
/** `Object.hasOwn` keeps words like `constructor` from reaching the prototype. */
const wordIn = <T>(words: Readonly<Record<string, T>>, input: string): T | undefined => {
  const word = input.trim().toLowerCase();
  return Object.hasOwn(words, word) ? words[word] : undefined;
};

export const UNAVAILABLE = "Odtwarzacz muzyki jest teraz niedostępny.";
export const NOT_IN_VOICE = "Najpierw wejdź na kanał głosowy.";
export const NOTHING_PLAYING = "Nic teraz nie gra.";
export const UNSUPPORTED_LINK = "Obsługuję tylko linki z YouTube, Bandcamp, Twitch i Vimeo.";
export const trackFailedText = (title: string) =>
  `Nie udało się odtworzyć **${escapeMarkdown(title)}**, gram dalej.`;
export const moreTracksFailedText = (count: number) =>
  `Kolejne utwory też nie działają, pominięte: ${count}.`;
export const EMPTY_QUEUE = "Kolejka jest pusta.";
export const queueChanged = "Kolejka zmieniła się w międzyczasie, spróbuj jeszcze raz.";
export const otherChannel = (channelId: string) =>
  `Musisz być na kanale <#${channelId}>, na którym gram.`;

interface PendingSearch {
  tracks: MusicTrack[];
}

export function createMusicModule({
  player,
  voice,
  panels,
  directMessages,
  scheduler,
  stateStorage,
  logger,
  idleMs = IDLE_MS,
}: MusicModuleDeps): BotModule {
  const searches = createComponentStateStore(stateStorage);

  // Commands are guild-only by default and the components declare guildOnly, so this never fires.
  const guildOf = (ctx: Pick<CommandContext, "guildId">) =>
    requireGuild(ctx.guildId, "Muzyka działa tylko na serwerze.");

  /** What the logs may say about a query: what it was, never what the member typed. */
  function describeQuery(query: MusicQuery): LogFields {
    return query.kind === "search"
      ? { kind: "search", length: query.text.length }
      : { kind: query.kind };
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

  const nextLoop = (mode: LoopMode): LoopMode =>
    LOOP_ORDER[(LOOP_ORDER.indexOf(mode) + 1) % LOOP_ORDER.length] ?? "off";

  /** Mixes the upcoming tracks; shared by `/shuffle` and its panel button. */
  function shuffleQueue(guildId: string, userId: string): Promise<void> {
    return oneAtATime(guildId, async () => {
      const state = await requireControl(guildId, userId);
      if (state.upcoming.length < 2) {
        throw new UserError("W kolejce jest za mało utworów, żeby je pomieszać.");
      }
      await player.shuffle(guildId);
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

  const loopButton = defineButton({
    module: MODULE,
    name: "panel-loop",
    public: true,
    guildOnly: true,
    async run(ctx) {
      const guildId = guildOf(ctx);
      // In the chain, so a double click reads the mode the first click set and moves on from there.
      await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        await player.setLoop(guildId, nextLoop(state.loop));
      });
      await updatePanelFromClick(ctx, guildId);
    },
  });

  const shuffleButton = defineButton({
    module: MODULE,
    name: "panel-shuffle",
    public: true,
    guildOnly: true,
    async run(ctx) {
      const guildId = guildOf(ctx);
      await shuffleQueue(guildId, ctx.user.id);
      await updatePanelFromClick(ctx, guildId);
    },
  });

  const buttons = {
    loop: (mode: LoopMode): ButtonSpec => ({
      type: "button",
      customId: loopButton.customId(PUBLIC_OWNER),
      label: `Pętla: ${LOOP_LABELS[mode]}`,
      emoji: mode === "track" ? "🔂" : "🔁",
      style: mode === "off" ? "secondary" : "success",
    }),
    shuffle: {
      type: "button",
      customId: shuffleButton.customId(PUBLIC_OWNER),
      label: "Losowo",
      emoji: "🔀",
      style: "secondary",
    },
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

  /** Guilds inside a failed-track window: how many failures came after its first note. */
  const failedBursts = new Map<string, { skipped: number; cancel: () => void }>();

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
      // A note after the bot left would be noise, and the next session starts its own window.
      failedBursts.get(guildId)?.cancel();
      failedBursts.delete(guildId);
      void inOrder(guildId, () => removePanel(guildId));
    },
    trackFailed(guildId, track) {
      if (track.byBot) return;
      const burst = failedBursts.get(guildId);
      if (burst) {
        burst.skipped++;
        return;
      }
      const channelId = player.state(guildId)?.textChannelId;
      if (!channelId) return;
      postFailedNote(guildId, channelId, trackFailedText(track.title));
      // A playlist full of removed videos fails track after track; one note per window keeps the chat usable.
      const cancel = scheduler.after(FAILED_NOTE_WINDOW_MS, () => {
        const ended = failedBursts.get(guildId);
        failedBursts.delete(guildId);
        if (ended && ended.skipped > 0) {
          postFailedNote(guildId, channelId, moreTracksFailedText(ended.skipped));
        }
      });
      failedBursts.set(guildId, { skipped: 0, cancel });
    },
  });

  function postFailedNote(guildId: string, channelId: string, content: string): void {
    panels.post(channelId, { content }).catch((error: unknown) => {
      logger.warn("Posting a failed track note failed", { guildId, error });
    });
  }

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
    // The bot was removed from the server: nothing is left to play into. (An outage is guildUnavailable.)
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
      const lines = queueLines(start + 1, state.upcoming.slice(start, start + QUEUE_PAGE_SIZE));
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
      description: "Link (YouTube…) albo czego szukać",
      required: true,
      rest: true,
    },
  } as const;

  const play = defineCommand({
    name: "play",
    description: "Odtwarza utwór albo playlistę z linku lub wyszukiwania",
    aliases: ["p"],
    options: queryOption,
    // Each call is a YouTube lookup through Lavalink; spamming it risks a block for everyone.
    cooldownMs: SEARCH_COOLDOWN_MS,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const query = queryOf(ctx.args.query, "Podaj link albo czego szukać.");
      await requireListener(guildId, ctx.user.id);
      await ctx.defer();
      const result = await player.search(query, ctx.user.id);
      if (result.kind === "error") {
        logger.info("Loading a track failed", {
          guildId,
          query: describeQuery(query),
          message: result.message,
        });
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
      // Joining the voice channel can take longer than the 3 s Discord gives a click to be answered.
      await ctx.defer();
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
    cooldownMs: SEARCH_COOLDOWN_MS,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const query = queryOf(ctx.args.query, "Podaj, czego szukać.");
      await requireListener(guildId, ctx.user.id);
      await ctx.defer({ ephemeral: true });
      const result = await player.search(query, ctx.user.id);
      if (result.kind === "error") {
        logger.info("Search failed", {
          guildId,
          query: describeQuery(query),
          message: result.message,
        });
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
      const embed = trackEmbed(
        state.current,
        state.positionMs,
        state.upcoming.length,
        settingsLine(state),
      );
      await ctx.reply({
        embeds: [
          { ...embed, footer: state.paused ? `Wstrzymane · ${embed.footer}` : embed.footer },
        ],
      });
    },
  });

  const redrawPanel = (guildId: string) => void inOrder(guildId, () => showPanel(guildId));

  const loop = defineCommand({
    name: "loop",
    description: "Ustawia powtarzanie: wyłączone, utwór albo kolejka",
    options: {
      mode: {
        type: "string",
        description: "Co powtarzać",
        required: true,
        choices: [
          { name: "wyłączone", value: "off" },
          { name: "utwór", value: "track" },
          { name: "kolejka", value: "queue" },
        ],
      },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      const mode = wordIn(LOOP_WORDS, ctx.args.mode);
      if (!mode) {
        throw new UserError(
          "Podaj `wyłącz`, `utwór` albo `kolejka` (albo `off`, `track`, `queue`).",
        );
      }
      await oneAtATime(guildId, async () => {
        await requireControl(guildId, ctx.user.id);
        await player.setLoop(guildId, mode);
      });
      redrawPanel(guildId);
      await ctx.reply(`Powtarzanie: **${LOOP_LABELS[mode]}**.`);
    },
  });

  const shuffle = defineCommand({
    name: "shuffle",
    description: "Miesza kolejkę",
    async run(ctx) {
      const guildId = guildOf(ctx);
      await shuffleQueue(guildId, ctx.user.id);
      redrawPanel(guildId);
      await ctx.reply("Pomieszano kolejkę.");
    },
  });

  const seek = defineCommand({
    name: "seek",
    description: "Przewija bieżący utwór (np. 1:30, 90 albo 1m30s)",
    options: {
      time: { type: "string", description: "Dokąd przewinąć", required: true, rest: true },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      const positionMs = parseTime(ctx.args.time);
      if (positionMs === null) {
        throw new UserError("Nie rozumiem czasu. Podaj np. `1:30`, `90` albo `1m30s`.");
      }
      await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        const current = state.current;
        if (!current) throw new UserError(NOTHING_PLAYING);
        if (current.isStream) throw new UserError("Transmisji na żywo nie da się przewijać.");
        if (!current.isSeekable) throw new UserError("Tego utworu nie da się przewijać.");
        // The end itself is allowed: the track ends and the next one plays.
        if (positionMs > current.durationMs) {
          throw new UserError(
            `Utwór trwa tylko ${formatDuration(current.durationMs)}, nie przewinę dalej.`,
          );
        }
        if (!(await player.seek(guildId, positionMs, current.id))) {
          throw new UserError("Utwór zmienił się w międzyczasie, spróbuj jeszcze raz.");
        }
      });
      redrawPanel(guildId);
      await ctx.reply(`Przewinięto do **${formatDuration(positionMs)}**.`);
    },
  });

  const volume = defineCommand({
    name: "volume",
    description: `Ustawia głośność (0-${MAX_VOLUME})`,
    aliases: ["vol"],
    options: {
      percent: {
        type: "integer",
        description: `Głośność w procentach (0-${MAX_VOLUME})`,
        required: true,
        minValue: 0,
        maxValue: MAX_VOLUME,
      },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      const percent = ctx.args.percent;
      if (!Number.isInteger(percent) || percent < 0 || percent > MAX_VOLUME) {
        throw new UserError(`Głośność musi być liczbą od 0 do ${MAX_VOLUME}.`);
      }
      await requireControl(guildId, ctx.user.id);
      await player.setVolume(guildId, percent);
      redrawPanel(guildId);
      await ctx.reply(`Głośność: **${percent}%**.`);
    },
  });

  const filter = defineCommand({
    name: "filter",
    description: "Włącza efekt dźwiękowy albo go wyłącza",
    options: {
      name: {
        type: "string",
        description: "Efekt",
        required: true,
        choices: [
          { name: "bassboost", value: "bassboost" },
          { name: "nightcore", value: "nightcore" },
          { name: "vaporwave", value: "vaporwave" },
          { name: "8D", value: "8d" },
          { name: "wyłącz", value: "off" },
        ],
      },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      const name = wordIn(FILTER_WORDS, ctx.args.name);
      if (!name) {
        throw new UserError(
          "Podaj `bassboost` (albo `bas`), `nightcore`, `vaporwave`, `8d` albo `wyłącz` (`off`).",
        );
      }
      // Refused here already, so the answer stays private; checked again in the chain.
      await requireControl(guildId, ctx.user.id);
      await ctx.defer();
      await oneAtATime(guildId, async () => {
        await requireControl(guildId, ctx.user.id);
        await player.setFilter(guildId, name);
      });
      redrawPanel(guildId);
      await ctx.reply(name === "off" ? "Wyłączono efekty." : `Efekt: **${FILTER_LABELS[name]}**.`);
    },
  });

  /** The place in `/queue` (1-based) as an index into the upcoming tracks, checked against the queue. */
  function queueIndexOf(state: PlayerState, place: number): number {
    if (state.upcoming.length === 0) throw new UserError(EMPTY_QUEUE);
    if (!Number.isInteger(place) || place < 1 || place > state.upcoming.length) {
      throw new UserError(
        `Nie ma utworu na miejscu ${place}. W kolejce jest ${state.upcoming.length} ${tracksWord(state.upcoming.length)}.`,
      );
    }
    return place - 1;
  }

  const placeOption = {
    place: {
      type: "integer",
      description: "Miejsce w kolejce (jak w /queue)",
      required: true,
      minValue: 1,
    },
  } as const;

  const remove = defineCommand({
    name: "remove",
    description: "Usuwa utwór z kolejki",
    options: placeOption,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const removed = await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        const index = queueIndexOf(state, ctx.args.place);
        const wanted = state.upcoming[index];
        if (!wanted) throw new UserError(queueChanged);
        const taken = await player.remove(guildId, index, wanted.id);
        if (!taken) throw new UserError(queueChanged);
        return taken;
      });
      redrawPanel(guildId);
      await ctx.reply(`Usunięto z kolejki: **${escapeMarkdown(removed.title)}**.`);
    },
  });

  const jump = defineCommand({
    name: "jump",
    description: "Przeskakuje do utworu z kolejki, pomijając te przed nim",
    options: placeOption,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const target = await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        const index = queueIndexOf(state, ctx.args.place);
        const wanted = state.upcoming[index];
        if (!wanted || !(await player.jump(guildId, index, wanted.id))) {
          throw new UserError(queueChanged);
        }
        return wanted;
      });
      await ctx.reply(`Przeskoczono do: **${escapeMarkdown(target.title)}**.`);
    },
  });

  const back = defineCommand({
    name: "back",
    description: "Wraca do poprzedniego utworu",
    async run(ctx) {
      const guildId = guildOf(ctx);
      const previous = await oneAtATime(guildId, async () => {
        await requireControl(guildId, ctx.user.id);
        return player.previous(guildId);
      });
      if (previous === "none") throw new UserError("Nie ma poprzedniego utworu.");
      if (previous === "changed") throw new UserError(queueChanged);
      await ctx.reply(`Wracam do: **${escapeMarkdown(previous.title)}**.`);
    },
  });

  const clear = defineCommand({
    name: "clear",
    description: "Czyści kolejkę, bieżący utwór gra dalej",
    async run(ctx) {
      const guildId = guildOf(ctx);
      const count = await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        if (state.upcoming.length === 0) throw new UserError(EMPTY_QUEUE);
        await player.clear(guildId);
        return state.upcoming.length;
      });
      redrawPanel(guildId);
      await ctx.reply(`Wyczyszczono kolejkę (${count} ${tracksWord(count)}).`);
    },
  });

  const save = defineCommand({
    name: "save",
    description: "Wysyła Ci w wiadomości prywatnej bieżący utwór",
    aliases: ["sv"],
    async run(ctx) {
      // Like /queue and /nowplaying: anyone in the server may save what plays, in voice or not.
      const current = player.state(guildOf(ctx))?.current;
      if (!current) throw new UserError(NOTHING_PLAYING);
      const link = httpUrl(current.uri);
      const delivered = await directMessages.send(ctx.user.id, {
        content: [
          `**${escapeMarkdown(current.title)}**`,
          `**Autor:** ${escapeMarkdown(current.author)}`,
          link ? `<${link}>` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      await ctx.reply({
        content: delivered
          ? "Wysłałem Ci ten utwór w wiadomości prywatnej."
          : "Nie mogę Ci wysłać wiadomości prywatnej. Sprawdź, czy masz je włączone dla członków serwera.",
        ephemeral: true,
      });
    },
  });

  return {
    name: MODULE,
    commands: [
      play,
      search,
      queue,
      skip,
      stop,
      pause,
      resume,
      nowPlaying,
      loop,
      shuffle,
      seek,
      volume,
      filter,
      remove,
      jump,
      back,
      clear,
      save,
    ],
    events: [voiceChange, guildGone],
    components: [
      pauseButton,
      skipButton,
      stopButton,
      queueButton,
      loopButton,
      shuffleButton,
      pick,
      queuePages.button,
    ],
    async dispose() {
      unsubscribe();
      for (const cancel of idleTimers.values()) cancel();
      idleTimers.clear();
      for (const { cancel } of failedBursts.values()) cancel();
      failedBursts.clear();
      // A panel left behind after shutdown would only offer buttons that answer "nothing is playing".
      await Promise.all(
        [...posted.keys()].map((guildId) => inOrder(guildId, () => removePanel(guildId))),
      );
    },
  };
}

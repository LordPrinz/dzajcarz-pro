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
  type Locale,
  type LocaleResolver,
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
import { t } from "./messages.ts";
import {
  filterLabel,
  loopLabel,
  PANEL_COLOR,
  panelMessage,
  queueLines,
  settingsLine,
  trackEmbed,
} from "./panel.ts";
import {
  type DirectMessages,
  type LoopMode,
  MAX_VOLUME,
  type MusicFilter,
  type MusicPlayer,
  type MusicQuery,
  type MusicTrack,
  type PanelMessages,
  type PlayerState,
  type VoiceChannels,
} from "./ports.ts";

/** The query rules of `/play`, for other entry points (the web panel) that must accept the same links. */
export { parseQuery } from "./format.ts";
export * from "./ports.ts";

export interface MusicModuleDeps {
  player: MusicPlayer;
  voice: VoiceChannels;
  panels: PanelMessages;
  /** `/save` sends the track this way. */
  directMessages: DirectMessages;
  /** The language of the panel and the notes posted in a server's channel, and of the `/save` message. */
  locales: LocaleResolver;
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
const LOOP_ORDER: readonly LoopMode[] = ["off", "track", "queue"];

interface PendingSearch {
  tracks: MusicTrack[];
}

export function createMusicModule({
  player,
  voice,
  panels,
  directMessages,
  locales,
  scheduler,
  stateStorage,
  logger,
  idleMs = IDLE_MS,
}: MusicModuleDeps): BotModule {
  const searches = createComponentStateStore(stateStorage);

  // Commands are guild-only by default and the components declare guildOnly, so this never fires.
  const guildOf = (ctx: Pick<CommandContext, "guildId">) => requireGuild(ctx.guildId);

  /** What the logs may say about a query: what it was, never what the member typed. */
  function describeQuery(query: MusicQuery): LogFields {
    return query.kind === "search"
      ? { kind: "search", length: query.text.length }
      : { kind: query.kind };
  }

  /** The member's input as a query; a link to another site is refused here. */
  function queryOf(input: string, emptyText: (locale: Locale) => string): MusicQuery {
    const query = parseQuery(input);
    if (!query) throw new UserError(emptyText);
    if (query.kind === "unsupported") throw new UserError((l) => t(l).unsupportedLink);
    return query;
  }

  /**
   * The caller must be in a voice channel, and in the bot's once the bot plays in the guild. Returns
   * the caller's channel and the guild's player, if any. `needsNode: false` lets a command that only
   * tears down (stop) through while the node is away.
   */
  async function requireListener(guildId: string, userId: string, needsNode = true) {
    if (needsNode && !player.available()) throw new UserError((l) => t(l).unavailable);
    const channelId = await voice.channelOf(guildId, userId);
    if (channelId === null) throw new UserError((l) => t(l).notInVoice);
    const state = player.state(guildId);
    if (state && state.voiceChannelId !== channelId) {
      throw new UserError((l) => t(l).otherChannel(state.voiceChannelId));
    }
    return { channelId, state };
  }

  /** Like `requireListener`, for controls: there must be something to control. */
  async function requireControl(
    guildId: string,
    userId: string,
    needsNode = true,
  ): Promise<PlayerState> {
    if (needsNode && !player.available()) throw new UserError((l) => t(l).unavailable);
    if (!player.state(guildId)) throw new UserError((l) => t(l).nothingPlaying);
    const { state } = await requireListener(guildId, userId, needsNode);
    if (!state) throw new UserError((l) => t(l).nothingPlaying);
    return state;
  }

  /** The scheduled song plays to the end: members cannot pause, skip, stop, seek or loop it. */
  function refuseSongControl(state: PlayerState) {
    if (state.current?.byBot) throw new UserError((l) => t(l).songLocked);
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
      if (room <= 0) throw new UserError((l) => t(l).queueFull(MAX_QUEUE_LENGTH));
      const accepted = tracks.slice(0, room);
      // Joining a song the bot plays on its own makes this channel the panel's for the tracks to come.
      if (!state || state.current?.byBot) await player.join(guildId, channelId, textChannelId);
      await player.enqueue(guildId, accepted);
      const startsNow = !state?.current;
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
        throw new UserError((l) => t(l).tooFewToShuffle);
      }
      await player.shuffle(guildId);
    });
  }

  function addedText(
    track: MusicTrack,
    startsNow: boolean,
    position: number,
    locale: Locale,
  ): string {
    const text = t(locale);
    const length = track.isStream ? text.liveShort : formatDuration(track.durationMs);
    const title = `**${escapeMarkdown(track.title)}** (${length})`;
    return startsNow ? text.playing(title) : text.queuedAt(position, title);
  }

  const pauseButton = defineButton({
    module: MODULE,
    name: "panel-pause",
    public: true,
    guildOnly: true,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const state = await requireControl(guildId, ctx.user.id);
      refuseSongControl(state);
      await fromClick(ctx, guildId, async () => {
        if (state.paused) await player.resume(guildId);
        else await player.pause(guildId);
      });
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
      refuseSongControl(state);
      if (!state.current) throw new UserError((l) => t(l).nothingPlaying);
      // The next trackStart (or queueEnd) redraws the panel.
      if (!(await player.skip(guildId, state.current.id)))
        throw new UserError((l) => t(l).queueChanged);
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
      refuseSongControl(await requireControl(guildId, ctx.user.id, false));
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
      await fromClick(ctx, guildId, () =>
        // In the chain, so a double click reads the mode the first click set and moves on from there.
        oneAtATime(guildId, async () => {
          const state = await requireControl(guildId, ctx.user.id);
          refuseSongControl(state);
          await player.setLoop(guildId, nextLoop(state.loop));
        }),
      );
    },
  });

  const shuffleButton = defineButton({
    module: MODULE,
    name: "panel-shuffle",
    public: true,
    guildOnly: true,
    async run(ctx) {
      const guildId = guildOf(ctx);
      await fromClick(ctx, guildId, () => shuffleQueue(guildId, ctx.user.id));
    },
  });

  /** The panel's buttons with their labels in `locale`. */
  const buttonsFor = (locale: Locale) => {
    const text = t(locale);
    return {
      loop: (mode: LoopMode): ButtonSpec => ({
        type: "button",
        customId: loopButton.customId(PUBLIC_OWNER),
        label: text.buttonLoop(loopLabel(mode, locale)),
        emoji: mode === "track" ? "🔂" : "🔁",
        style: mode === "off" ? "secondary" : "success",
      }),
      shuffle: {
        type: "button",
        customId: shuffleButton.customId(PUBLIC_OWNER),
        label: text.buttonShuffle,
        emoji: "🔀",
        style: "secondary",
      },
      pause: (paused: boolean): ButtonSpec => ({
        type: "button",
        customId: pauseButton.customId(PUBLIC_OWNER),
        label: paused ? text.buttonResume : text.buttonPause,
        emoji: paused ? "▶️" : "⏸️",
        style: "primary",
      }),
      skip: {
        type: "button",
        customId: skipButton.customId(PUBLIC_OWNER),
        label: text.buttonSkip,
        emoji: "⏭️",
        style: "secondary",
      },
      stop: {
        type: "button",
        customId: stopButton.customId(PUBLIC_OWNER),
        label: text.buttonStop,
        emoji: "⏹️",
        style: "danger",
      },
      queue: {
        type: "button",
        customId: queueButton.customId(PUBLIC_OWNER),
        label: text.buttonQueue,
        emoji: "📜",
        style: "secondary",
      },
    } satisfies Parameters<typeof panelMessage>[1];
  };

  /** The panel in `locale`; null when nothing is playing or the bot plays its own track. */
  const panelFor = (state: PlayerState, locale: Locale) =>
    panelMessage(state, buttonsFor(locale), locale);

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
    // The panel lives in the server's channel, so it speaks the server's language.
    const message = state && panelFor(state, await locales.guild(guildId));
    // The scheduled song has no panel, and one left from before it must not keep live buttons.
    if (state?.current?.byBot) return removePanel(guildId);
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

  /** Guilds with a redraw queued that has not started yet; another change before it starts adds nothing. */
  const redrawQueued = new Set<string>();

  /** Redraws the panel after a change, from whoever made it (a member, the web panel). */
  function redrawPanel(guildId: string): void {
    if (redrawQueued.has(guildId)) return;
    redrawQueued.add(guildId);
    void inOrder(guildId, () => {
      redrawQueued.delete(guildId);
      return showPanel(guildId);
    });
  }

  /**
   * Panel clicks being handled, per guild. `drawn` turns true once the click has read the state it draws;
   * `held` records a change left to the click before that read, `missed` one that came after it.
   */
  interface Click {
    drawn: boolean;
    held: boolean;
    missed: boolean;
  }
  const clicks = new Map<string, Set<Click>>();

  /**
   * Runs a panel button's change, then edits the clicked panel through the interaction. A `stateChanged`
   * before the click reads the state is in that edit, so it is not redrawn; one after the read (another
   * member, the web panel) gets a redraw once the click is done.
   */
  async function fromClick(
    ctx: ComponentContext,
    guildId: string,
    change: () => Promise<void>,
  ): Promise<void> {
    const click: Click = { drawn: false, held: false, missed: false };
    const active = clicks.get(guildId) ?? new Set();
    clicks.set(guildId, active.add(click));
    let updated = false;
    try {
      await change();
      const state = player.state(guildId);
      click.drawn = true;
      const message = state && panelFor(state, ctx.locale);
      if (message) await ctx.update(message);
      updated = true;
    } finally {
      active.delete(click);
      if (active.size === 0 && clicks.get(guildId) === active) clicks.delete(guildId);
      // A refused click draws nothing, so what it held back is drawn here.
      if (click.missed || (click.held && !updated)) redrawPanel(guildId);
    }
  }

  /**
   * Whether a click being handled takes care of this change: a click that has not read the state yet draws
   * it, one that has redraws when it is done. Redrawing now could land before the click's own edit, which
   * would then put the older state back.
   */
  function drawnByClick(guildId: string): boolean {
    const active = clicks.get(guildId);
    if (!active || active.size === 0) return false;
    for (const click of active) {
      if (click.drawn) click.missed = true;
      else click.held = true;
    }
    return true;
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
      redrawPanel(guildId);
      void reviewIdle(guildId);
    },
    stateChanged(guildId) {
      if (!drawnByClick(guildId)) redrawPanel(guildId);
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
      postFailedNote(guildId, channelId, (text) => text.trackFailed(escapeMarkdown(track.title)));
      // A playlist full of removed videos fails track after track; one note per window keeps the chat usable.
      const cancel = scheduler.after(FAILED_NOTE_WINDOW_MS, () => {
        const ended = failedBursts.get(guildId);
        failedBursts.delete(guildId);
        if (ended && ended.skipped > 0) {
          postFailedNote(guildId, channelId, (text) => text.moreTracksFailed(ended.skipped));
        }
      });
      failedBursts.set(guildId, { skipped: 0, cancel });
    },
  });

  function postFailedNote(
    guildId: string,
    channelId: string,
    content: (text: ReturnType<typeof t>) => string,
  ): void {
    locales
      .guild(guildId)
      .then((locale) => panels.post(channelId, { content: content(t(locale)) }))
      .catch((error: unknown) => {
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
      const text = t(viewer.locale);
      if (!state?.current) return { content: text.nothingPlaying, pageCount: 1 };
      const pageCount = Math.max(1, Math.ceil(state.upcoming.length / QUEUE_PAGE_SIZE));
      const start = page * QUEUE_PAGE_SIZE;
      const lines = queueLines(
        start + 1,
        state.upcoming.slice(start, start + QUEUE_PAGE_SIZE),
        viewer.locale,
      );
      const total = state.upcoming.reduce((sum, track) => sum + track.durationMs, 0);
      return {
        embeds: [
          {
            title: text.queueTitle,
            color: PANEL_COLOR,
            description: [
              `**${text.queueNow}:** ${escapeMarkdown(truncate(state.current.title, 80))}`,
              "",
              lines.length > 0 ? lines.join("\n") : text.queueRestEmpty,
            ].join("\n"),
            footer:
              state.upcoming.length === 0
                ? undefined
                : `${text.trackCount(state.upcoming.length)} · ${formatDuration(total)}`,
          },
        ],
        pageCount,
      };
    },
  });

  const queryOption = {
    query: {
      type: "string",
      description: t.all("queryOption"),
      required: true,
      rest: true,
    },
  } as const;

  const play = defineCommand({
    name: "play",
    description: t.all("playDescription"),
    aliases: ["p"],
    options: queryOption,
    // Each call is a YouTube lookup through Lavalink; spamming it risks a block for everyone.
    cooldownMs: SEARCH_COOLDOWN_MS,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const query = queryOf(ctx.args.query, (l) => t(l).enterQueryPlay);
      await requireListener(guildId, ctx.user.id);
      await ctx.defer();
      const result = await player.search(query, ctx.user.id);
      if (result.kind === "error") {
        logger.info("Loading a track failed", {
          guildId,
          query: describeQuery(query),
          message: result.message,
        });
        throw new UserError((l) => t(l).loadFailed);
      }
      if (result.kind === "empty" || result.tracks.length === 0) {
        throw new UserError((l) => t(l).nothingFound);
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
        if (track) {
          await ctx.reply(addedText(track, added.startsNow, added.position, ctx.locale));
        }
        return;
      }
      const count = added.accepted.length;
      const skipped = result.tracks.length - count;
      const text = t(ctx.locale);
      const note =
        skipped === 0 ? "" : text.playlistSkipped(skipped, MAX_PLAYLIST_TRACKS, MAX_QUEUE_LENGTH);
      await ctx.reply(
        `${text.playlistAdded(text.trackCount(count), escapeMarkdown(result.name))}${note}`,
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
      if (!track) throw new UserError((l) => t(l).noSuchResult);
      // Joining the voice channel can take longer than the 3 s Discord gives a click to be answered.
      await ctx.defer();
      const added = await addTracks(guildId, ctx.user.id, ctx.channelId, [track]);
      await ctx.update({
        content: addedText(track, added.startsNow, added.position, ctx.locale),
        components: [],
      });
    },
  });

  const search = defineCommand({
    name: "search",
    description: t.all("searchDescription"),
    options: queryOption,
    cooldownMs: SEARCH_COOLDOWN_MS,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const query = queryOf(ctx.args.query, (l) => t(l).enterQuery);
      await requireListener(guildId, ctx.user.id);
      await ctx.defer({ ephemeral: true });
      const result = await player.search(query, ctx.user.id);
      if (result.kind === "error") {
        logger.info("Search failed", {
          guildId,
          query: describeQuery(query),
          message: result.message,
        });
        throw new UserError((l) => t(l).searchFailed);
      }
      const tracks = result.kind === "empty" ? [] : result.tracks.slice(0, MAX_SEARCH_RESULTS);
      if (tracks.length === 0) throw new UserError((l) => t(l).nothingFound);
      const key = await searches.save({ tracks } satisfies PendingSearch);
      await ctx.reply({
        content: t(ctx.locale).pickTrack,
        ephemeral: true,
        components: [
          [
            {
              type: "select",
              customId: pick.customId(ctx.user.id, key),
              placeholder: t(ctx.locale).searchResults,
              options: tracks.map((track, index) => ({
                label: truncate(track.title, 100),
                value: String(index),
                description: truncate(
                  `${track.author} · ${track.isStream ? t(ctx.locale).liveShort : formatDuration(track.durationMs)}`,
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
    description: t.all("queueDescription"),
    async run(ctx) {
      guildOf(ctx);
      await ctx.reply({ ...(await queuePages.first(ctx)), ephemeral: true });
    },
  });

  const skip = defineCommand({
    name: "skip",
    description: t.all("skipDescription"),
    async run(ctx) {
      const guildId = guildOf(ctx);
      const state = await requireControl(guildId, ctx.user.id);
      refuseSongControl(state);
      if (!state.current) throw new UserError((l) => t(l).nothingPlaying);
      if (!(await player.skip(guildId, state.current.id)))
        throw new UserError((l) => t(l).queueChanged);
      await ctx.reply(t(ctx.locale).skipped(escapeMarkdown(state.current.title)));
    },
  });

  const stop = defineCommand({
    name: "stop",
    description: t.all("stopDescription"),
    async run(ctx) {
      const guildId = guildOf(ctx);
      // Works while the node is away too: the bot still leaves voice.
      refuseSongControl(await requireControl(guildId, ctx.user.id, false));
      await player.leave(guildId);
      await ctx.reply(t(ctx.locale).stopped);
    },
  });

  const pause = defineCommand({
    name: "pause",
    description: t.all("pauseDescription"),
    async run(ctx) {
      const guildId = guildOf(ctx);
      const state = await requireControl(guildId, ctx.user.id);
      refuseSongControl(state);
      if (!state.current) throw new UserError((l) => t(l).nothingPlaying);
      if (state.paused) throw new UserError((l) => t(l).alreadyPaused);
      await player.pause(guildId);
      await ctx.reply(t(ctx.locale).paused);
    },
  });

  const resume = defineCommand({
    name: "resume",
    description: t.all("resumeDescription"),
    async run(ctx) {
      const guildId = guildOf(ctx);
      const state = await requireControl(guildId, ctx.user.id);
      if (!state.paused) throw new UserError((l) => t(l).notPaused);
      await player.resume(guildId);
      await ctx.reply(t(ctx.locale).resumed);
    },
  });

  const nowPlaying = defineCommand({
    name: "nowplaying",
    description: t.all("nowPlayingDescription"),
    aliases: ["np"],
    async run(ctx) {
      const state = player.state(guildOf(ctx));
      if (!state?.current) throw new UserError((l) => t(l).nothingPlaying);
      const embed = trackEmbed(
        state.current,
        state.positionMs,
        state.upcoming.length,
        settingsLine(state, ctx.locale),
        ctx.locale,
      );
      await ctx.reply({
        embeds: [
          {
            ...embed,
            footer: state.paused ? `${t(ctx.locale).pausedFooter} · ${embed.footer}` : embed.footer,
          },
        ],
      });
    },
  });

  const loop = defineCommand({
    name: "loop",
    description: t.all("loopDescription"),
    options: {
      mode: {
        type: "string",
        description: t.all("loopOption"),
        required: true,
        choices: [
          { name: t.all("loopChoiceOff"), value: "off", aliases: ["wyłącz", "wyłączona"] },
          { name: t.all("loopTrack"), value: "track" },
          { name: t.all("loopQueue"), value: "queue" },
        ],
      },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      // Slash and prefix both hold the value to the choices before `run`.
      const mode = ctx.args.mode as LoopMode;
      await oneAtATime(guildId, async () => {
        refuseSongControl(await requireControl(guildId, ctx.user.id));
        await player.setLoop(guildId, mode);
      });
      await ctx.reply(t(ctx.locale).loopSet(loopLabel(mode, ctx.locale)));
    },
  });

  const shuffle = defineCommand({
    name: "shuffle",
    description: t.all("shuffleDescription"),
    async run(ctx) {
      const guildId = guildOf(ctx);
      await shuffleQueue(guildId, ctx.user.id);
      await ctx.reply(t(ctx.locale).shuffled);
    },
  });

  const seek = defineCommand({
    name: "seek",
    description: t.all("seekDescription"),
    options: {
      time: { type: "string", description: t.all("seekOption"), required: true, rest: true },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      const positionMs = parseTime(ctx.args.time);
      if (positionMs === null) {
        throw new UserError((l) => t(l).timeUnclear);
      }
      await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        refuseSongControl(state);
        const current = state.current;
        if (!current) throw new UserError((l) => t(l).nothingPlaying);
        if (current.isStream) throw new UserError((l) => t(l).streamNoSeek);
        if (!current.isSeekable) throw new UserError((l) => t(l).notSeekable);
        // The end itself is allowed: the track ends and the next one plays.
        if (positionMs > current.durationMs) {
          throw new UserError((l) => t(l).seekTooFar(formatDuration(current.durationMs)));
        }
        if (!(await player.seek(guildId, positionMs, current.id))) {
          throw new UserError((l) => t(l).trackChanged);
        }
      });
      await ctx.reply(t(ctx.locale).seeked(formatDuration(positionMs)));
    },
  });

  const volume = defineCommand({
    name: "volume",
    description: t.all("volumeDescription"),
    aliases: ["vol"],
    options: {
      percent: {
        type: "integer",
        description: t.all("volumeOption"),
        required: true,
        minValue: 0,
        maxValue: MAX_VOLUME,
      },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      const percent = ctx.args.percent;
      if (!Number.isInteger(percent) || percent < 0 || percent > MAX_VOLUME) {
        throw new UserError((l) => t(l).volumeRange(MAX_VOLUME));
      }
      await requireControl(guildId, ctx.user.id);
      await player.setVolume(guildId, percent);
      await ctx.reply(t(ctx.locale).volumeSet(percent));
    },
  });

  const filter = defineCommand({
    name: "filter",
    description: t.all("filterDescription"),
    options: {
      name: {
        type: "string",
        description: t.all("filterOption"),
        required: true,
        choices: [
          { name: "bassboost", value: "bassboost", aliases: ["bas"] },
          { name: "nightcore", value: "nightcore" },
          { name: "vaporwave", value: "vaporwave" },
          { name: "8D", value: "8d" },
          { name: t.all("filterChoiceOff"), value: "off", aliases: ["wyłącz"] },
        ],
      },
    },
    async run(ctx) {
      const guildId = guildOf(ctx);
      const name = ctx.args.name as MusicFilter;
      // Refused here already, so the answer stays private; checked again in the chain.
      await requireControl(guildId, ctx.user.id);
      await ctx.defer();
      await oneAtATime(guildId, async () => {
        await requireControl(guildId, ctx.user.id);
        await player.setFilter(guildId, name);
      });
      const text = t(ctx.locale);
      await ctx.reply(
        name === "off" ? text.filtersOff : text.filterSet(filterLabel(name, ctx.locale)),
      );
    },
  });

  /** The place in `/queue` (1-based) as an index into the upcoming tracks, checked against the queue. */
  function queueIndexOf(state: PlayerState, place: number): number {
    if (state.upcoming.length === 0) throw new UserError((l) => t(l).emptyQueue);
    if (!Number.isInteger(place) || place < 1 || place > state.upcoming.length) {
      throw new UserError((l) =>
        t(l).noTrackAtPlace(place, t(l).trackCount(state.upcoming.length)),
      );
    }
    return place - 1;
  }

  const placeOption = {
    place: {
      type: "integer",
      description: t.all("placeOption"),
      required: true,
      minValue: 1,
    },
  } as const;

  const remove = defineCommand({
    name: "remove",
    description: t.all("removeDescription"),
    options: placeOption,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const removed = await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        const index = queueIndexOf(state, ctx.args.place);
        const wanted = state.upcoming[index];
        if (!wanted) throw new UserError((l) => t(l).queueChanged);
        const taken = await player.remove(guildId, index, wanted.id);
        if (!taken) throw new UserError((l) => t(l).queueChanged);
        return taken;
      });
      await ctx.reply(t(ctx.locale).removed(escapeMarkdown(removed.title)));
    },
  });

  const jump = defineCommand({
    name: "jump",
    description: t.all("jumpDescription"),
    options: placeOption,
    async run(ctx) {
      const guildId = guildOf(ctx);
      const target = await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        refuseSongControl(state);
        const index = queueIndexOf(state, ctx.args.place);
        const wanted = state.upcoming[index];
        if (!wanted || !(await player.jump(guildId, index, wanted.id))) {
          throw new UserError((l) => t(l).queueChanged);
        }
        return wanted;
      });
      await ctx.reply(t(ctx.locale).jumped(escapeMarkdown(target.title)));
    },
  });

  const back = defineCommand({
    name: "back",
    description: t.all("backDescription"),
    async run(ctx) {
      const guildId = guildOf(ctx);
      const previous = await oneAtATime(guildId, async () => {
        refuseSongControl(await requireControl(guildId, ctx.user.id));
        return player.previous(guildId);
      });
      if (previous === "none") throw new UserError((l) => t(l).noPrevious);
      if (previous === "changed") throw new UserError((l) => t(l).queueChanged);
      await ctx.reply(t(ctx.locale).wentBack(escapeMarkdown(previous.title)));
    },
  });

  const clear = defineCommand({
    name: "clear",
    description: t.all("clearDescription"),
    async run(ctx) {
      const guildId = guildOf(ctx);
      const count = await oneAtATime(guildId, async () => {
        const state = await requireControl(guildId, ctx.user.id);
        if (state.upcoming.length === 0) throw new UserError((l) => t(l).emptyQueue);
        await player.clear(guildId);
        return state.upcoming.length;
      });
      await ctx.reply(t(ctx.locale).cleared(t(ctx.locale).trackCount(count)));
    },
  });

  const save = defineCommand({
    name: "save",
    description: t.all("saveDescription"),
    aliases: ["sv"],
    async run(ctx) {
      // Like /queue and /nowplaying: anyone in the server may save what plays, in voice or not.
      const current = player.state(guildOf(ctx))?.current;
      if (!current) throw new UserError((l) => t(l).nothingPlaying);
      const link = httpUrl(current.uri);
      // The message goes to the member's DMs, so it speaks their own language.
      const dmText = t(await locales.user(ctx.user.id));
      const delivered = await directMessages.send(ctx.user.id, {
        content: [
          `**${escapeMarkdown(current.title)}**`,
          `**${dmText.author}:** ${escapeMarkdown(current.author)}`,
          link ? `<${link}>` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      await ctx.reply({
        content: delivered ? t(ctx.locale).saveSent : t(ctx.locale).saveBlocked,
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

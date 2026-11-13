import {
  defineButton,
  defineEvent,
  defineUserSelect,
  type Locale,
  PUBLIC_OWNER,
  type Reply,
  UserError,
} from "@dzajcarz/core";
import type { Client } from "discord.js";
import type { createControls } from "./controls.ts";
import { t } from "./messages.ts";
import type { createSpecialInvites } from "./special-invites.ts";
import type { PartyArea, PartyModuleDeps } from "./types.ts";

/** Messages in a command channel (the panel excepted) are deleted this long after they appear. */
const CHAT_CLEANUP_MS = 15_000;
/** Messages that fall due within this window of each other are deleted in one request. */
const CLEANUP_BATCH_MS = 1_000;
/** A panel deleted again within this window is reposted only when it ends: bounds a loop against another bot or automod. */
const PANEL_REPOST_COOLDOWN_MS = 30_000;

export function createPanel(
  { repository, chat, scheduler, locales, logger }: PartyModuleDeps,
  controls: ReturnType<typeof createControls>,
  special: ReturnType<typeof createSpecialInvites>,
) {
  const {
    limitModal,
    renameModal,
    lockChannel,
    unlockChannel,
    hideChannel,
    showChannel,
    inviteMember,
    blockMember,
    controlledChannel,
  } = controls;
  const { specialInviteModal, checkSpecialAllowed } = special;

  /** What a panel button does; the id is the button's custom_id state. */
  const PANEL_BUTTONS = {
    lock: { label: "buttonLock", emoji: "🔒", run: lockChannel },
    unlock: { label: "buttonUnlock", emoji: "🔓", run: unlockChannel },
    hide: { label: "buttonHide", emoji: "🙈", run: hideChannel },
    show: { label: "buttonShow", emoji: "👁️", run: showChannel },
  } as const;
  const PANEL_FORMS = {
    limit: { label: "buttonLimit", emoji: "👥", modal: limitModal },
    rename: { label: "buttonRename", emoji: "✏️", modal: renameModal },
    special: { label: "buttonSpecial", emoji: "💌", modal: specialInviteModal },
  } as const;
  const PANEL_USER_ACTIONS = {
    invite: { placeholder: "selectInvite", run: inviteMember },
    block: { placeholder: "selectBlock", run: blockMember },
  } as const;

  const isKey = <T extends object>(table: T, key: string): key is Extract<keyof T, string> =>
    Object.hasOwn(table, key);

  // Public: anyone may press them, and each press acts on the presser's own party channel.
  const panelButton = defineButton({
    module: "party",
    name: "panel",
    guildOnly: true,
    public: true,
    run: async (ctx) => {
      if (isKey(PANEL_BUTTONS, ctx.state)) return PANEL_BUTTONS[ctx.state].run(ctx);
      if (isKey(PANEL_FORMS, ctx.state)) {
        // Refuse before the form opens, so nobody types a name only to be told they have no channel. This
        // runs inside the three seconds Discord gives for the modal (a later one fails with 10062), so it
        // is one Redis increment, a cached voice state and one row, plus a member lookup only for a
        // non-owner. The cooldown keeps repeated presses from turning into a stream of those lookups.
        const { channel } = await controlledChannel(ctx, ctx.state);
        if (ctx.state === "special") await checkSpecialAllowed(ctx, channel);
        return ctx.showModal(PANEL_FORMS[ctx.state].modal.build(ctx.user.id));
      }
      throw new UserError((l) => t(l).panelOutdated);
    },
  });

  const panelUserSelect = defineUserSelect({
    module: "party",
    name: "panel-user",
    guildOnly: true,
    public: true,
    run: async (ctx) => {
      const userId = ctx.values[0];
      if (!isKey(PANEL_USER_ACTIONS, ctx.state) || !userId) {
        throw new UserError((l) => t(l).panelOutdated);
      }
      // Redrawing the panel clears the choice in the menu, so the next pick starts from the placeholder.
      await ctx.update(panelMessage(ctx.locale));
      await PANEL_USER_ACTIONS[ctx.state].run(ctx, userId);
    },
  });

  /** The embed and controls in a command channel. Static, so any press can redraw it unchanged. */
  function panelMessage(locale: Locale): Reply {
    const buttons = { ...PANEL_BUTTONS, ...PANEL_FORMS };
    const button = (action: keyof typeof buttons) => ({
      type: "button" as const,
      customId: panelButton.customId(PUBLIC_OWNER, action),
      label: t(locale)[buttons[action].label],
      emoji: buttons[action].emoji,
    });
    const userSelect = (action: keyof typeof PANEL_USER_ACTIONS) => ({
      type: "user-select" as const,
      customId: panelUserSelect.customId(PUBLIC_OWNER, action),
      placeholder: t(locale)[PANEL_USER_ACTIONS[action].placeholder],
    });
    return {
      embeds: [
        {
          title: t(locale).panelTitle,
          description: t(locale).panelDescription,
        },
      ],
      components: [
        [button("lock"), button("unlock"), button("hide"), button("show")],
        [button("limit"), button("rename"), button("special")],
        [userSelect("invite")],
        [userSelect("block")],
      ],
    };
  }

  /*
   * The command channel: the text chat of an area's join voice channel. One panel message (its id is in
   * `party_area.panel_message_id`), everything else is deleted after CHAT_CLEANUP_MS.
   */

  /**
   * Join channel ids of the areas with a command channel. Every message in the guild reaches the message
   * handlers, so they ask this set (no database, no gate) before doing anything. Filled at startup and kept
   * current wherever the flag or the area changes.
   */
  const commandChannels = new Set<string>();
  function trackCommandChannel(joinChannelId: string, on: boolean): void {
    if (on) commandChannels.add(joinChannelId);
    else commandChannels.delete(joinChannelId);
  }

  /** Panel work per area runs one at a time, so two triggers (an edit, a deleted panel) never post two. */
  const panelQueue = new Map<string, Promise<unknown>>();
  function serialized<T>(joinChannelId: string, task: () => Promise<T>): Promise<T> {
    const previous = panelQueue.get(joinChannelId) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.catch(() => {});
    panelQueue.set(joinChannelId, tail);
    void tail.then(() => {
      if (panelQueue.get(joinChannelId) === tail) panelQueue.delete(joinChannelId);
    });
    return result;
  }

  /**
   * Makes the chat match the area's flag: panel posted (again, if it is gone) when on, removed when off.
   * With `sweep` it also deletes the leftover messages, for startup. Returns whether it failed, for the
   * caller to tell the member (in the language of the member).
   */
  function syncPanel(joinChannelId: string, sweep = false): Promise<boolean> {
    return serialized(joinChannelId, async () => {
      try {
        const area = await repository.findAreaByJoinChannel(joinChannelId);
        if (!area) {
          commandChannels.delete(joinChannelId);
          return false;
        }
        trackCommandChannel(joinChannelId, area.commandChannel);
        if (!area.commandChannel) {
          await removePanel(area);
          return false;
        }
        const panelId = await ensurePanel(area);
        if (sweep && panelId) await deleteLeftovers(joinChannelId, panelId);
        return false;
      } catch (error) {
        logger.warn("Party panel not synced", { joinChannelId, error });
        return true;
      }
    });
  }

  /** The id of the area's panel, posting a new one when there is none or it was deleted. Null when the area is gone. */
  async function ensurePanel(area: PartyArea): Promise<string | null> {
    const { joinChannelId, panelMessageId } = area;
    if (panelMessageId && (await chat.exists(joinChannelId, panelMessageId))) return panelMessageId;
    const messageId = await chat.post(
      joinChannelId,
      panelMessage(await locales.guild(area.guildId)),
    );
    let stored: boolean;
    try {
      stored = await repository.setPanelMessage(joinChannelId, messageId);
    } catch (error) {
      await chat.deleteMessages(joinChannelId, [messageId]).catch(() => {});
      throw error;
    }
    // The area was removed meanwhile; its chat goes with the channel, but do not leave a panel behind.
    if (!stored) {
      await chat.deleteMessages(joinChannelId, [messageId]).catch(() => {});
      return null;
    }
    return messageId;
  }

  async function removePanel(area: PartyArea): Promise<void> {
    if (!area.panelMessageId) return;
    await chat.deleteMessages(area.joinChannelId, [area.panelMessageId]);
    await repository.setPanelMessage(area.joinChannelId, null);
  }

  /**
   * Pinned and system messages are somebody's on purpose (or not ours to delete): the sweep leaves them.
   * So are the bot's own, which are the now-playing panel and the notes of commands run from this chat.
   */
  async function deleteLeftovers(joinChannelId: string, panelId: string): Promise<void> {
    const stale = (await chat.recentMessages(joinChannelId))
      .filter(
        (message) =>
          message.id !== panelId &&
          !message.pinned &&
          !message.system &&
          message.authorId !== chat.selfId(),
      )
      .map((message) => message.id);
    if (stale.length > 0) await chat.deleteMessages(joinChannelId, stale);
  }

  /** Timers waiting to delete a message or flush a batch, so shutdown can cancel them. */
  const cleanups = new Set<() => void>();
  function schedule(delayMs: number, task: () => void): void {
    const cancel = scheduler.after(delayMs, () => {
      cleanups.delete(cancel);
      task();
    });
    cleanups.add(cancel);
  }

  /** Messages that are due, per join channel, waiting for the flush that deletes them together. */
  const due = new Map<string, string[]>();

  function scheduleCleanup(joinChannelId: string, messageId: string): void {
    schedule(CHAT_CLEANUP_MS, () => {
      const batch = due.get(joinChannelId);
      if (batch) {
        batch.push(messageId);
        return;
      }
      due.set(joinChannelId, [messageId]);
      schedule(CLEANUP_BATCH_MS, () => {
        const ids = due.get(joinChannelId) ?? [];
        due.delete(joinChannelId);
        void deleteStale(joinChannelId, ids);
      });
    });
  }

  /** Channels whose failed cleanup is already in the log, so a missing Manage Messages is one line, not one per message. */
  const cleanupFailing = new Set<string>();

  /** Never throws. Looks again when the flush runs: the flag or the panel may have changed meanwhile. */
  async function deleteStale(joinChannelId: string, messageIds: string[]): Promise<void> {
    try {
      const area = await repository.findAreaByJoinChannel(joinChannelId);
      if (!area?.commandChannel) return;
      const ids = messageIds.filter((id) => id !== area.panelMessageId);
      if (ids.length === 0) return;
      await chat.deleteMessages(joinChannelId, ids);
      cleanupFailing.delete(joinChannelId);
    } catch (error) {
      if (cleanupFailing.has(joinChannelId)) return;
      cleanupFailing.add(joinChannelId);
      logger.warn("Could not delete command channel messages (logged once until it works again)", {
        joinChannelId,
        error,
      });
    }
  }

  // Not gated by the module toggle (`alwaysRun`): switching the party module off must not leave a chat
  // that fills up or a panel that is gone. Only the panel's buttons are gated.
  const chatMessage = defineEvent({
    name: "party-chat-message",
    event: "messageCreate",
    alwaysRun: true,
    run: async (message: {
      id: string;
      channelId: string;
      guildId: string | null;
      author?: { id: string };
      pinned?: boolean;
      system?: boolean;
    }) => {
      if (!message.guildId || !commandChannels.has(message.channelId)) return;
      // System messages (joins, pins) are not ours to delete, and a pinned one was kept on purpose.
      if (message.pinned || message.system) return;
      // The bot's own messages (panel, now-playing, notes) are not clutter; members' are.
      if (message.author && message.author.id === chat.selfId()) return;
      try {
        const area = await repository.findAreaByJoinChannel(message.channelId);
        if (!area?.commandChannel || message.id === area.panelMessageId) return;
        scheduleCleanup(area.joinChannelId, message.id);
      } catch (error) {
        logger.warn("Could not schedule command channel cleanup", {
          channelId: message.channelId,
          error,
        });
      }
    },
  });

  /** Join channels whose panel was reposted lately; true means it was deleted again meanwhile. */
  const repostCooldown = new Map<string, boolean>();

  /** Reposts the panel (if it is gone) and holds further reposts back for the cooldown. */
  async function repostPanel(joinChannelId: string): Promise<void> {
    repostCooldown.set(joinChannelId, false);
    schedule(PANEL_REPOST_COOLDOWN_MS, () => {
      const deletedAgain = repostCooldown.get(joinChannelId) === true;
      repostCooldown.delete(joinChannelId);
      // syncPanel checks that the panel is really gone, so a stale flag costs one request.
      if (deletedAgain && commandChannels.has(joinChannelId)) void repostPanel(joinChannelId);
    });
    await syncPanel(joinChannelId);
  }

  /**
   * Never throws. Reposts the panel when it is among the deleted messages, at most once per cooldown: a
   * panel that keeps getting deleted (another bot, automod) is reposted when the cooldown ends, not at once.
   */
  async function onMessagesDeleted(channelId: string, messageIds: string[]): Promise<void> {
    if (!commandChannels.has(channelId)) return;
    try {
      const area = await repository.findAreaByJoinChannel(channelId);
      if (!area?.commandChannel || !area.panelMessageId) return;
      if (!messageIds.includes(area.panelMessageId)) return;
      if (repostCooldown.has(channelId)) repostCooldown.set(channelId, true);
      else await repostPanel(channelId);
    } catch (error) {
      logger.warn("Party panel repost failed", { channelId, error });
    }
  }

  const panelDeleted = defineEvent({
    name: "party-panel-deleted",
    event: "messageDelete",
    alwaysRun: true,
    run: (message: { id: string; channelId: string }) =>
      onMessagesDeleted(message.channelId, [message.id]),
  });

  const panelBulkDeleted = defineEvent({
    name: "party-panel-bulk-deleted",
    event: "messageDeleteBulk",
    alwaysRun: true,
    run: (messages: ReadonlyMap<string, unknown>, channel: { id: string }) =>
      onMessagesDeleted(channel.id, [...messages.keys()]),
  });

  const panels = defineEvent({
    name: "party-panels",
    event: "clientReady",
    once: true,
    alwaysRun: true,
    run: (_client: Client<true>) => restorePanels(),
  });

  /**
   * On startup: remembers which areas have a command channel, then brings back panels missing or deleted
   * while offline and deletes messages left over. Covers every area, whatever the module toggle says.
   * Never throws.
   */
  async function restorePanels(): Promise<void> {
    try {
      let restored = 0;
      const areas = await repository.listAllAreas();
      for (const { joinChannelId, commandChannel } of areas) {
        trackCommandChannel(joinChannelId, commandChannel);
      }
      for (const { joinChannelId, commandChannel } of areas) {
        if (!commandChannel) continue;
        try {
          if (!(await syncPanel(joinChannelId, true))) restored++;
        } catch (error) {
          logger.warn("Could not restore a party panel", { joinChannelId, error });
        }
      }
      logger.info("Party panels restored", { restored });
    } catch (error) {
      logger.error("Party panel restore failed", { error });
    }
  }

  function dispose(): void {
    for (const cancel of cleanups) cancel();
    cleanups.clear();
  }

  return {
    panelButton,
    panelUserSelect,
    commandChannels,
    trackCommandChannel,
    syncPanel,
    cleanups,
    chatMessage,
    panelDeleted,
    panelBulkDeleted,
    panels,
    dispose,
  };
}

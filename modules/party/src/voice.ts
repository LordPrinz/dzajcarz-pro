import { defineEvent } from "@dzajcarz/core";
import type { Channel, Client, Guild, VoiceState } from "discord.js";
import type { createAreas } from "./areas.ts";
import type { createLimits } from "./limits.ts";
import { renderChannelName } from "./naming.ts";
import type { PartyArea, PartyModuleDeps } from "./types.ts";

/** Long enough to create a channel and move the member, short enough that a crash frees the lock fast. */
const LOCK_TTL_MS = 30_000;
/** Reconciliation leaves younger channels alone: their owner may still be mid-join. */
const RECONCILE_GRACE_MS = 15_000;
/** How often a leave re-checks the owner after a handover, in case the new owner left meanwhile. */
const OWNER_CHECK_ROUNDS = 3;

export function createVoice(
  { repository, channels, permissions, lock, locales, logger }: PartyModuleDeps,
  limits: ReturnType<typeof createLimits>,
  areas: ReturnType<typeof createAreas>,
) {
  const { overCreationLimit } = limits;
  const { deleteQuietly, dismantleArea } = areas;

  /** The member's channel, reusing a live one; `created` is true only for a channel made by this call. Null when the cooldown applies. */
  async function ownedOrNew(
    area: PartyArea,
    userId: string,
    displayName: string,
  ): Promise<{ channelId: string; created: boolean } | null> {
    const existing = await repository.findChannelByOwner(area.guildId, userId);
    if (existing) {
      // Null members means the channel vanished without a channelDelete reaching us.
      if ((await channels.members(existing.channelId)) !== null) {
        return { channelId: existing.channelId, created: false };
      }
      await repository.deleteChannel(existing.channelId);
    }
    if (await overCreationLimit(area.guildId, userId)) {
      logger.debug("Channel creation skipped, member is over the limit", {
        guildId: area.guildId,
        userId,
      });
      return null;
    }
    const name = renderChannelName(
      area.nameTemplate,
      displayName,
      await locales.guild(area.guildId),
    );
    const channelId = await channels.createVoiceChannel(
      area.guildId,
      area.categoryId,
      name,
      userId,
    );
    // Best effort: without Manage Roles the channel works, it only cannot be locked safely.
    const reason = `Party: create for ${userId}`;
    try {
      await permissions.allowSelf(channelId, reason);
    } catch (error) {
      logger.warn("Could not give the bot its own overwrite on the party channel", {
        channelId,
        error,
      });
    }
    try {
      // A locked or hidden channel must stay usable for its owner.
      await permissions.allowMember(channelId, userId, reason);
    } catch (error) {
      logger.warn("Could not give the owner an overwrite on the party channel", {
        channelId,
        userId,
        error,
      });
    }
    try {
      await repository.addChannel({
        channelId,
        guildId: area.guildId,
        ownerId: userId,
        joinChannelId: area.joinChannelId,
      });
    } catch (error) {
      await deleteQuietly(channelId);
      throw error;
    }
    return { channelId, created: true };
  }

  async function handleJoin(
    guildId: string,
    userId: string,
    displayName: string,
    joinedChannelId: string,
  ): Promise<void> {
    const area = await repository.findAreaByJoinChannel(joinedChannelId);
    if (!area) return;

    const key = `party:${guildId}:${userId}`;
    // A random token, so a holder whose lock expired cannot release the next holder's lock.
    const token = crypto.randomUUID();
    let held = false;
    try {
      held = await lock.setIfAbsent(key, token, LOCK_TTL_MS);
      if (!held) {
        logger.debug("Join ignored, another one is in progress", { guildId, userId });
        return;
      }
    } catch (error) {
      // Redis down or stalled: carry on. The unique (guild, owner) row still stops duplicates. The SET may
      // still land late and would block the member's joins for the whole TTL, so ask to drop it.
      logger.warn("Party lock unavailable", { guildId, userId, error });
      void lock.delIfEquals(key, token).catch(() => {});
    }

    try {
      const target = await ownedOrNew(area, userId, displayName);
      if (!target) return;
      // The member may have left the join channel while the channel was being made.
      const inJoinChannel = (await channels.members(joinedChannelId))?.includes(userId) ?? false;
      if (!inJoinChannel) {
        if (target.created) await removeChannel(target.channelId);
        return;
      }
      try {
        await channels.moveMember(guildId, userId, target.channelId);
      } catch (error) {
        // Only a channel made just now is ours to discard; an existing one may hold other people.
        if (target.created) await removeChannel(target.channelId);
        throw error;
      }
    } finally {
      if (held) {
        // A release that failed or timed out is asked once more in the background, so the lock does not
        // outlive the join for the whole TTL.
        await lock.delIfEquals(key, token).catch(() => {
          void lock.delIfEquals(key, token).catch(() => {});
        });
      }
    }
  }

  /** Deletes the Discord channel, then the row. If Discord refuses the row stays so a later leave or reconcile retries. */
  async function removeChannel(channelId: string): Promise<void> {
    try {
      await channels.deleteChannel(channelId);
    } catch (error) {
      logger.warn("Could not delete channel, keeping its row to retry later", {
        channelId,
        error,
      });
      return;
    }
    await repository.deleteChannel(channelId);
  }

  async function handleLeave(leftChannelId: string): Promise<void> {
    // Each round re-reads the owner and the members: an heir may leave while the transfer runs, and the
    // channel must not end up owned by someone who is gone.
    for (let round = 0; round < OWNER_CHECK_ROUNDS; round++) {
      const owned = await repository.findChannel(leftChannelId);
      if (!owned) return;
      const members = await channels.members(leftChannelId);
      if (members === undefined) return;
      if (members === null || members.length === 0) {
        await removeChannel(leftChannelId);
        return;
      }
      if (members.includes(owned.ownerId)) return;
      // The owner left but others stay: the first one who is free to own a channel takes over.
      let transferred = false;
      for (const candidate of members) {
        if (await repository.transferOwner(leftChannelId, owned.ownerId, candidate)) {
          logger.info("Party channel ownership transferred", {
            channelId: leftChannelId,
            from: owned.ownerId,
            to: candidate,
          });
          await moveOwnerAccess(leftChannelId, owned.ownerId, candidate);
          transferred = true;
          break;
        }
      }
      if (!transferred) return;
    }
  }

  /** Best effort: the new owner keeps access to a locked channel, the old one loses the special pass. */
  async function moveOwnerAccess(channelId: string, from: string, to: string): Promise<void> {
    try {
      const reason = `Party: ownership transfer to ${to}`;
      await permissions.allowMember(channelId, to, reason);
      await permissions.clearMember(channelId, from, reason);
    } catch (error) {
      logger.warn("Could not move owner overwrites", { channelId, from, to, error });
    }
  }

  /** The human whose voice channel changed, or null for bots and for mute/deafen updates. */
  function channelChange(oldState: VoiceState, newState: VoiceState) {
    if (oldState.channelId === newState.channelId) return null;
    const member = newState.member ?? oldState.member;
    return !member || member.user.bot ? null : member;
  }

  /** Leaves in progress by `guild:user`, so a join by the same member waits for the cleanup of the channel they just left. */
  const leaving = new Map<string, Promise<void>>();

  const leave = defineEvent({
    name: "party-leave",
    event: "voiceStateUpdate",
    // Cleanup must happen even if the module was switched off while channels exist.
    alwaysRun: true,
    run: (oldState: VoiceState, newState: VoiceState) => {
      const member = channelChange(oldState, newState);
      if (!member || !oldState.channelId) return;
      const key = `${newState.guild.id}:${member.id}`;
      // Registered before the first await: the join handler is invoked right after this one returns.
      const done = onLeave(newState.guild.id, oldState.channelId);
      leaving.set(key, done);
      return done.finally(() => {
        if (leaving.get(key) === done) leaving.delete(key);
      });
    },
  });

  /** Never throws: Discord and the database fail now and then, and a voice event must not crash the bot. */
  async function onLeave(guildId: string, channelId: string): Promise<void> {
    try {
      await handleLeave(channelId);
    } catch (error) {
      logger.warn("Party channel cleanup failed", { guildId, channelId, error });
    }
  }

  const join = defineEvent({
    name: "party-join",
    event: "voiceStateUpdate",
    run: async (oldState: VoiceState, newState: VoiceState) => {
      const member = channelChange(oldState, newState);
      if (!member || !newState.channelId) return;
      const guildId = newState.guild.id;
      // Moving from your own channel into the join channel frees (or hands over) it before a new one is made.
      await leaving.get(`${guildId}:${member.id}`);
      try {
        await handleJoin(guildId, member.id, member.displayName, newState.channelId);
      } catch (error) {
        logger.warn("Party channel not created", {
          guildId,
          userId: member.id,
          channelId: newState.channelId,
          error,
        });
      }
    },
  });

  const removed = defineEvent({
    name: "party-channel-delete",
    event: "channelDelete",
    alwaysRun: true,
    run: (channel: Channel) => onChannelDelete(channel),
  });

  /** Never throws. Handles hand-deleted channels, and our own deletions too (then there is nothing to do). */
  async function onChannelDelete(channel: Channel): Promise<void> {
    try {
      const area =
        (await repository.findAreaByJoinChannel(channel.id)) ??
        (await repository.findAreaByCategory(channel.id));
      if (area) {
        // Party channels outside their category would be orphaned, and an area without one of its two
        // channels is useless, so the rest goes too.
        const areaChannels = await dismantleArea(area);
        logger.info("Party area removed", { channelId: channel.id, areaChannels });
        return;
      }
      await repository.deleteChannel(channel.id);
    } catch (error) {
      logger.warn("Party cleanup after channel delete failed", { channelId: channel.id, error });
    }
  }

  const reconcile = defineEvent({
    name: "party-reconcile",
    event: "clientReady",
    once: true,
    alwaysRun: true,
    run: (_client: Client<true>) => reconcileChannels(),
  });

  /** Guilds whose voice states were unknown during the startup reconcile; their channels wait for them. */
  const waitingGuilds = new Set<string>();

  // discord.js also emits guildAvailable for every guild while it starts, before clientReady; only a guild
  // the startup reconcile could not check needs a second look.
  const reconcileLate = defineEvent({
    name: "party-reconcile-late",
    event: "guildAvailable",
    alwaysRun: true,
    run: async (guild: Guild) => {
      if (waitingGuilds.delete(guild.id)) await reconcileChannels(guild.id);
    },
  });

  /** Catches up with what happened while the bot was offline; never throws. Without a guild id checks all. */
  async function reconcileChannels(guildId?: string): Promise<void> {
    try {
      const droppedAreas = guildId === undefined ? await reconcileAreas() : 0;
      const stored = (await repository.listChannels()).filter(
        (channel) => guildId === undefined || channel.guildId === guildId,
      );
      let removedCount = 0;
      let unknownCount = 0;
      for (const { channelId, guildId: channelGuild, createdAt } of stored) {
        if (Date.now() - createdAt.getTime() < RECONCILE_GRACE_MS) continue;
        try {
          const members = await channels.members(channelId);
          if (members === undefined) {
            unknownCount++;
            waitingGuilds.add(channelGuild);
            continue;
          }
          if (members !== null && members.length > 0) {
            // The owner may have left while the bot was offline.
            await handleLeave(channelId);
            continue;
          }
          await removeChannel(channelId);
          removedCount++;
        } catch (error) {
          logger.warn("Could not check party channel", { channelId, error });
        }
      }
      logger.info("Party channels reconciled", {
        guildId,
        checked: stored.length,
        removed: removedCount,
        waitingForGuild: unknownCount,
        droppedAreas,
      });
    } catch (error) {
      logger.error("Party reconciliation failed", { guildId, error });
    }
  }

  /** Drops areas whose join channel or category was deleted while the bot was offline. */
  async function reconcileAreas(): Promise<number> {
    let dropped = 0;
    for (const area of await repository.listAllAreas()) {
      try {
        const [joinExists, categoryExists] = await Promise.all([
          channels.exists(area.joinChannelId),
          channels.exists(area.categoryId),
        ]);
        if (joinExists && categoryExists) continue;
        await dismantleArea(area);
        dropped++;
      } catch (error) {
        logger.warn("Could not check party area", { joinChannelId: area.joinChannelId, error });
      }
    }
    return dropped;
  }

  return { leave, join, removed, reconcile, reconcileLate };
}

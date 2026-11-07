import {
  type BotModule,
  defineCommand,
  defineEvent,
  defineSubcommand,
  type Logger,
  UserError,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import type { Channel, Client, VoiceState } from "discord.js";

export interface PartyArea {
  guildId: string;
  categoryId: string;
  joinChannelId: string;
}

export interface PartyChannel {
  channelId: string;
  guildId: string;
  ownerId: string;
  /** The join channel of the area the channel was created for. */
  joinChannelId: string;
  createdAt: Date;
}

/** Where areas and owned channels are stored. */
export interface PartyRepository {
  addArea(area: PartyArea): Promise<void>;
  listAreas(guildId: string): Promise<PartyArea[]>;
  listAllAreas(): Promise<PartyArea[]>;
  findAreaByJoinChannel(joinChannelId: string): Promise<PartyArea | null>;
  findAreaByCategory(categoryId: string): Promise<PartyArea | null>;
  /** Removes the area and its channel rows in one transaction and returns those rows; null when the area was unknown. */
  deleteArea(joinChannelId: string): Promise<PartyChannel[] | null>;
  /** Rejects when the member already owns a channel in the guild. */
  addChannel(channel: Omit<PartyChannel, "createdAt">): Promise<void>;
  findChannel(channelId: string): Promise<PartyChannel | null>;
  findChannelByOwner(guildId: string, ownerId: string): Promise<PartyChannel | null>;
  listChannelsOfArea(joinChannelId: string): Promise<PartyChannel[]>;
  listChannels(): Promise<PartyChannel[]>;
  /** False when the row was already gone. */
  deleteChannel(channelId: string): Promise<boolean>;
  /** False when the channel is gone or the member already owns another channel in the guild. */
  transferOwner(channelId: string, newOwnerId: string): Promise<boolean>;
}

/** What the bot does on Discord. Every method rejects when Discord refuses. */
export interface PartyChannels {
  /** Creates a voice channel in the category and returns its id. `ownerId` goes to the audit log. */
  createVoiceChannel(
    guildId: string,
    categoryId: string,
    name: string,
    ownerId: string,
  ): Promise<string>;
  moveMember(guildId: string, userId: string, channelId: string): Promise<void>;
  /** A channel that is already gone counts as deleted. */
  deleteChannel(channelId: string): Promise<void>;
  /** Ids of the people (bots excluded) in the voice channel; null when the channel no longer exists. */
  members(channelId: string): Promise<string[] | null>;
  /** Whether the channel still exists on Discord. */
  exists(channelId: string): Promise<boolean>;
  /** Creates a category and the voice channel inside it that members join. Leaves nothing behind on failure. */
  createCategoryWithJoinChannel(
    guildId: string,
    categoryName: string,
  ): Promise<{ categoryId: string; joinChannelId: string }>;
}

export interface PartyModuleDeps {
  repository: PartyRepository;
  channels: PartyChannels;
  /** The join lock and the creation cooldown. */
  lock: Pick<KeyValueStore, "setIfAbsent" | "delIfEquals" | "increment">;
  logger: Logger;
}

/** PermissionFlagsBits.ManageChannels; modules do not import discord.js at runtime. */
const MANAGE_CHANNELS = 1n << 4n;
/** Discord's limit for channel and category names. */
const MAX_NAME_LENGTH = 100;
/** Long enough to create a channel and move the member, short enough that a crash frees the lock fast. */
const LOCK_TTL_MS = 30_000;
/** A member may cause this many new channels per window; more joins are ignored (channel create/delete spam). */
const MAX_CREATIONS = 3;
const CREATION_WINDOW_MS = 60_000;
/** Reconciliation leaves younger channels alone: their owner may still be mid-join. */
const RECONCILE_GRACE_MS = 15_000;

export function createPartyModule({
  repository,
  channels,
  lock,
  logger,
}: PartyModuleDeps): BotModule {
  const guildOf = (guildId: string | null): string => {
    if (guildId === null) throw new UserError("Ta komenda działa tylko na serwerze.");
    return guildId;
  };

  /** Removes a Discord channel and swallows the failure: the caller has the state it wants anyway. */
  async function deleteQuietly(channelId: string): Promise<void> {
    try {
      await channels.deleteChannel(channelId);
    } catch (error) {
      logger.warn("Could not delete channel", { channelId, error });
    }
  }

  /**
   * Drops the area's rows, then its Discord channels: party channels, join channel and category. Channels
   * that are already gone are fine. Returns how many party channels the area had.
   */
  async function dismantleArea(area: PartyArea): Promise<number> {
    const owned = (await repository.deleteArea(area.joinChannelId)) ?? [];
    for (const { channelId } of owned) await deleteQuietly(channelId);
    await deleteQuietly(area.joinChannelId);
    await deleteQuietly(area.categoryId);
    return owned.length;
  }

  const party = defineCommand({
    name: "party",
    description: "Strefa imprezowa: kanały głosowe tworzone na życzenie",
    permissions: MANAGE_CHANNELS,
    subcommands: {
      create: defineSubcommand({
        description: "Tworzy kategorię z kanałem, na który wchodzi się po własny kanał głosowy",
        options: {
          name: {
            type: "string",
            description: "Nazwa kategorii",
            required: true,
            rest: true,
          },
        },
        run: async (ctx) => {
          const guildId = guildOf(ctx.guildId);
          const name = ctx.args.name.trim();
          if (name.length === 0) throw new UserError("Podaj nazwę kategorii.");
          if (name.length > MAX_NAME_LENGTH) {
            throw new UserError(`Nazwa może mieć najwyżej ${MAX_NAME_LENGTH} znaków.`);
          }
          await ctx.defer();
          let created: { categoryId: string; joinChannelId: string };
          try {
            created = await channels.createCategoryWithJoinChannel(guildId, name);
          } catch (error) {
            logger.warn("Party area not created on Discord", { guildId, error });
            throw new UserError(
              "Nie mogę utworzyć kanałów. Sprawdź, czy bot ma uprawnienia „Zarządzanie kanałami” i „Przenoszenie członków”.",
            );
          }
          try {
            await repository.addArea({ guildId, ...created });
          } catch (error) {
            await deleteQuietly(created.joinChannelId);
            await deleteQuietly(created.categoryId);
            throw error;
          }
          await ctx.reply({
            content: `Strefa imprezowa gotowa. Wejdź na <#${created.joinChannelId}>, a dostaniesz własny kanał głosowy.`,
            ephemeral: true,
          });
        },
      }),
      delete: defineSubcommand({
        description: "Usuwa strefę imprezową razem z jej kanałami",
        options: {
          channel: {
            type: "channel",
            description: "Kanał wejściowy strefy (gdy jest ich kilka)",
          },
        },
        run: async (ctx) => {
          const guildId = guildOf(ctx.guildId);
          await ctx.defer({ ephemeral: true });
          const area = await pickArea(guildId, ctx.args.channel);
          await dismantleArea(area);
          await ctx.reply({ content: "Strefa imprezowa usunięta.", ephemeral: true });
        },
      }),
    },
  });

  async function pickArea(guildId: string, joinChannelId: string | undefined): Promise<PartyArea> {
    if (joinChannelId !== undefined) {
      const area = await repository.findAreaByJoinChannel(joinChannelId);
      if (!area || area.guildId !== guildId) {
        throw new UserError("Ten kanał nie jest wejściem do strefy imprezowej.");
      }
      return area;
    }
    const areas = await repository.listAreas(guildId);
    const [only] = areas;
    if (!only) throw new UserError("Na tym serwerze nie ma strefy imprezowej.");
    if (areas.length > 1) {
      const list = areas.map((a) => `<#${a.joinChannelId}>`).join(", ");
      throw new UserError(`Jest kilka stref (${list}). Wskaż kanał wejściowy tej do usunięcia.`);
    }
    return only;
  }

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
    const name = `Kanał ${displayName}`.slice(0, MAX_NAME_LENGTH);
    const channelId = await channels.createVoiceChannel(
      area.guildId,
      area.categoryId,
      name,
      userId,
    );
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

  /** Counts a creation; fails open when Redis is down. */
  async function overCreationLimit(guildId: string, userId: string): Promise<boolean> {
    try {
      const { count } = await lock.increment(
        `party-cooldown:${guildId}:${userId}`,
        CREATION_WINDOW_MS,
      );
      return count > MAX_CREATIONS;
    } catch (error) {
      logger.warn("Party cooldown unavailable", { guildId, userId, error });
      return false;
    }
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
      // Redis down: carry on. The unique (guild, owner) row still stops duplicates.
      logger.warn("Party lock unavailable", { guildId, userId, error });
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
      if (held) await lock.delIfEquals(key, token).catch(() => {});
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
    const owned = await repository.findChannel(leftChannelId);
    if (!owned) return;
    const members = await channels.members(leftChannelId);
    if (members === null || members.length === 0) {
      await removeChannel(leftChannelId);
      return;
    }
    if (members.includes(owned.ownerId)) return;
    // The owner left but others stay: the first one who is free to own a channel takes over.
    for (const candidate of members) {
      if (await repository.transferOwner(leftChannelId, candidate)) {
        logger.info("Party channel ownership transferred", {
          channelId: leftChannelId,
          from: owned.ownerId,
          to: candidate,
        });
        return;
      }
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

  /** Catches up with what happened while the bot was offline; never throws. */
  async function reconcileChannels(): Promise<void> {
    try {
      const droppedAreas = await reconcileAreas();
      const stored = await repository.listChannels();
      let removedCount = 0;
      for (const { channelId, createdAt } of stored) {
        if (Date.now() - createdAt.getTime() < RECONCILE_GRACE_MS) continue;
        try {
          const members = await channels.members(channelId);
          if (members !== null && members.length > 0) continue;
          await removeChannel(channelId);
          removedCount++;
        } catch (error) {
          logger.warn("Could not check party channel", { channelId, error });
        }
      }
      logger.info("Party channels reconciled", {
        checked: stored.length,
        removed: removedCount,
        droppedAreas,
      });
    } catch (error) {
      logger.error("Party reconciliation failed", { error });
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

  return { name: "party", commands: [party], events: [leave, join, removed, reconcile] };
}

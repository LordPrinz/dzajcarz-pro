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
}

/** Where areas and owned channels are stored. */
export interface PartyRepository {
  addArea(area: PartyArea): Promise<void>;
  listAreas(guildId: string): Promise<PartyArea[]>;
  findAreaByJoinChannel(joinChannelId: string): Promise<PartyArea | null>;
  findAreaByCategory(categoryId: string): Promise<PartyArea | null>;
  /** Also removes the area's channel rows. False when the area was unknown. */
  deleteArea(joinChannelId: string): Promise<boolean>;
  /** Rejects when the member already owns a channel in the guild. */
  addChannel(channel: PartyChannel): Promise<void>;
  findChannel(channelId: string): Promise<PartyChannel | null>;
  findChannelByOwner(guildId: string, ownerId: string): Promise<PartyChannel | null>;
  listChannelsOfArea(joinChannelId: string): Promise<PartyChannel[]>;
  listChannels(): Promise<PartyChannel[]>;
  /** False when the row was already gone. */
  deleteChannel(channelId: string): Promise<boolean>;
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
  /** People (bots excluded) in the voice channel; null when the channel no longer exists. */
  memberCount(channelId: string): Promise<number | null>;
  /** Creates a category and the voice channel inside it that members join. Leaves nothing behind on failure. */
  createCategoryWithJoinChannel(
    guildId: string,
    categoryName: string,
  ): Promise<{ categoryId: string; joinChannelId: string }>;
}

export interface PartyModuleDeps {
  repository: PartyRepository;
  channels: PartyChannels;
  /** Only the lock operations are used. */
  lock: Pick<KeyValueStore, "setIfAbsent" | "del">;
  logger: Logger;
}

/** PermissionFlagsBits.ManageChannels; modules do not import discord.js at runtime. */
const MANAGE_CHANNELS = 1n << 4n;
/** Discord's limit for channel and category names. */
const MAX_NAME_LENGTH = 100;
/** Long enough to create a channel and move the member, short enough that a crash frees the lock fast. */
const LOCK_TTL_MS = 10_000;

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
              "Nie mogę utworzyć kanałów. Sprawdź, czy bot ma uprawnienie do zarządzania kanałami.",
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
          const area = await pickArea(guildId, ctx.args.channel);
          const owned = await repository.listChannelsOfArea(area.joinChannelId);
          await ctx.defer();
          await repository.deleteArea(area.joinChannelId);
          for (const { channelId } of owned) await deleteQuietly(channelId);
          await deleteQuietly(area.joinChannelId);
          await deleteQuietly(area.categoryId);
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

  async function ownedOrNew(area: PartyArea, userId: string, displayName: string): Promise<string> {
    const existing = await repository.findChannelByOwner(area.guildId, userId);
    if (existing) {
      // A null count means the channel vanished without a channelDelete reaching us.
      if ((await channels.memberCount(existing.channelId)) !== null) return existing.channelId;
      await repository.deleteChannel(existing.channelId);
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
    return channelId;
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
    let held = false;
    try {
      held = await lock.setIfAbsent(key, "1", LOCK_TTL_MS);
      if (!held) {
        logger.debug("Join ignored, another one is in progress", { guildId, userId });
        return;
      }
    } catch (error) {
      // Redis down: carry on. The unique (guild, owner) row still stops duplicates.
      logger.warn("Party lock unavailable", { guildId, userId, error });
    }

    try {
      const channelId = await ownedOrNew(area, userId, displayName);
      try {
        await channels.moveMember(guildId, userId, channelId);
      } catch (error) {
        // The member left voice or the bot cannot move them: do not leave an empty channel behind.
        await removeChannel(channelId);
        throw error;
      }
    } finally {
      if (held) await lock.del(key).catch(() => {});
    }
  }

  async function removeChannel(channelId: string): Promise<void> {
    await deleteQuietly(channelId);
    await repository.deleteChannel(channelId);
  }

  async function handleLeave(leftChannelId: string): Promise<void> {
    const owned = await repository.findChannel(leftChannelId);
    if (!owned) return;
    const count = await channels.memberCount(leftChannelId);
    if (count === null || count === 0) await removeChannel(leftChannelId);
  }

  const voice = defineEvent({
    name: "party-voice",
    event: "voiceStateUpdate",
    run: (oldState: VoiceState, newState: VoiceState) => onVoiceStateUpdate(oldState, newState),
  });

  /** Never throws: Discord and the database fail now and then, and a voice event must not crash the bot. */
  async function onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    if (oldState.channelId === newState.channelId) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    const guildId = newState.guild.id;

    // Leaving first: moving from your own channel into the join channel frees it before a new one is made.
    if (oldState.channelId) {
      try {
        await handleLeave(oldState.channelId);
      } catch (error) {
        logger.warn("Party channel cleanup failed", {
          guildId,
          channelId: oldState.channelId,
          error,
        });
      }
    }
    if (newState.channelId) {
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
    }
  }

  const removed = defineEvent({
    name: "party-channel-delete",
    event: "channelDelete",
    run: (channel: Channel) => onChannelDelete(channel),
  });

  /** Never throws. Handles hand-deleted channels, and our own deletions too (then there is nothing to do). */
  async function onChannelDelete(channel: Channel): Promise<void> {
    try {
      const area =
        (await repository.findAreaByJoinChannel(channel.id)) ??
        (await repository.findAreaByCategory(channel.id));
      if (area) {
        // Party channels outside their category would be orphaned and never cleaned up, so remove them too.
        const owned = await repository.listChannelsOfArea(area.joinChannelId);
        await repository.deleteArea(area.joinChannelId);
        for (const { channelId } of owned) await deleteQuietly(channelId);
        logger.info("Party area removed", { channelId: channel.id, areaChannels: owned.length });
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
    run: (_client: Client<true>) => reconcileChannels(),
  });

  /** Channels that emptied while the bot was offline; never throws. */
  async function reconcileChannels(): Promise<void> {
    try {
      const stored = await repository.listChannels();
      let removedCount = 0;
      for (const { channelId } of stored) {
        try {
          const count = await channels.memberCount(channelId);
          if (count !== null && count > 0) continue;
          await removeChannel(channelId);
          removedCount++;
        } catch (error) {
          logger.warn("Could not check party channel", { channelId, error });
        }
      }
      logger.info("Party channels reconciled", { checked: stored.length, removed: removedCount });
    } catch (error) {
      logger.error("Party reconciliation failed", { error });
    }
  }

  return { name: "party", commands: [party], events: [voice, removed, reconcile] };
}

import {
  type BotModule,
  type CommandContext,
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
  /**
   * Compare-and-swap: makes `newOwnerId` the owner only while `expectedOwnerId` still is. False when the
   * owner changed, the channel is gone or the member already owns another channel in the guild.
   */
  transferOwner(channelId: string, expectedOwnerId: string, newOwnerId: string): Promise<boolean>;
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
  /** The voice channel the member is in right now, or null when they are in none. */
  voiceChannelOf(guildId: string, userId: string): Promise<string | null>;
}

/** What `setEveryone` changes: true allows, false denies, null clears the overwrite, undefined leaves it alone. */
export interface EveryoneAccess {
  connect?: boolean | null;
  view?: boolean | null;
}

/** Who a user id belongs to, as far as the party controls care. */
export interface GuildMemberInfo {
  /** The bot itself. */
  self: boolean;
  /** Has Administrator, Manage Channels or Move Members in the guild: someone the owner may not lock out. */
  moderator: boolean;
}

/**
 * Permission overwrites and settings of a party channel. Every method rejects when Discord refuses.
 * `reason` is what the server's audit log shows.
 */
export interface PartyPermissions {
  /** Changes the @everyone overwrite of the channel. */
  setEveryone(channelId: string, access: EveryoneAccess, reason: string): Promise<void>;
  /** What the channel's category says about @everyone (deny → false, allow → true, none → null). */
  inheritedEveryone(channelId: string): Promise<{ connect: boolean | null; view: boolean | null }>;
  /** Lets the bot itself see, join and manage the channel, so locking or hiding never shuts it out. */
  allowSelf(channelId: string, reason: string): Promise<void>;
  /** Lets the member see and join the channel whatever @everyone may do. */
  allowMember(channelId: string, userId: string, reason: string): Promise<void>;
  /** Stops the member from seeing and joining the channel. */
  denyMember(channelId: string, userId: string, reason: string): Promise<void>;
  /** Removes the member's own overwrite. */
  clearMember(channelId: string, userId: string, reason: string): Promise<void>;
  /** 0 means no limit. */
  setLimit(channelId: string, limit: number, reason: string): Promise<void>;
  rename(channelId: string, name: string, reason: string): Promise<void>;
  /** Kicks the member out of voice, but only while they are in `channelId`. */
  disconnect(guildId: string, userId: string, channelId: string, reason: string): Promise<void>;
  /** Null when the user is not a member of the guild. */
  lookupMember(guildId: string, userId: string): Promise<GuildMemberInfo | null>;
  /** Whether the member has Manage Channels on that very channel (overwrites included). */
  canManage(guildId: string, userId: string, channelId: string): Promise<boolean>;
}

export interface PartyModuleDeps {
  repository: PartyRepository;
  channels: PartyChannels;
  permissions: PartyPermissions;
  /** The join lock and the creation cooldown. */
  lock: Pick<KeyValueStore, "setIfAbsent" | "delIfEquals" | "increment">;
  logger: Logger;
}

/** PermissionFlagsBits.ManageChannels; modules do not import discord.js at runtime. */
const MANAGE_CHANNELS = 1n << 4n;
/** Discord allows two renames per channel per ten minutes; counting here avoids a rate-limit stall. */
const MAX_RENAMES = 2;
const RENAME_WINDOW_MS = 600_000;
/** Owner controls per member: every one is a Discord call, so a flood is cut off here. */
const MAX_CONTROLS = 10;
const CONTROL_WINDOW_MS = 60_000;
/** Discord's limit for channel and category names. */
const MAX_NAME_LENGTH = 100;
/** Discord's user limit for a voice channel is 99; 0 removes it. */
const MAX_USER_LIMIT = 99;
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
  permissions,
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
    // No command-level permission: Discord would hide the owner controls from regular members.
    subcommands: {
      create: defineSubcommand({
        description: "Tworzy kategorię z kanałem, na który wchodzi się po własny kanał głosowy",
        permissions: MANAGE_CHANNELS,
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
              "Nie mogę utworzyć kanałów. Sprawdź, czy bot ma uprawnienia „Zarządzanie kanałami”, „Przenoszenie członków” i „Zarządzanie rolami” (nadpisania uprawnień).",
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
        permissions: MANAGE_CHANNELS,
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
      lock: defineSubcommand({
        description: "Zamyka twój kanał dla nowych osób",
        run: async (ctx) => {
          const { channel, reason } = await controlledChannel(ctx, "lock");
          await permissions.setEveryone(channel.channelId, { connect: false }, reason);
          await ownerReply(ctx, channel, "lock", "Kanał zamknięty. Wejdą tylko zaproszeni.");
        },
      }),
      unlock: defineSubcommand({
        description: "Otwiera twój kanał z powrotem",
        run: async (ctx) => {
          const { channel, reason } = await controlledChannel(ctx, "unlock");
          // Back to what the category says, so a private area stays private.
          const { connect } = await permissions.inheritedEveryone(channel.channelId);
          await permissions.setEveryone(channel.channelId, { connect }, reason);
          await ownerReply(ctx, channel, "unlock", "Kanał otwarty.");
        },
      }),
      limit: defineSubcommand({
        description: "Ustawia limit osób na twoim kanale (0 = bez limitu)",
        options: {
          count: {
            type: "integer",
            description: "Limit osób, 0 = bez limitu",
            required: true,
            minValue: 0,
            maxValue: MAX_USER_LIMIT,
          },
        },
        run: async (ctx) => {
          const { channel, reason } = await controlledChannel(ctx, "limit");
          await permissions.setLimit(channel.channelId, ctx.args.count, reason);
          await ownerReply(
            ctx,
            channel,
            "limit",
            ctx.args.count === 0
              ? "Limit osób usunięty."
              : `Limit osób ustawiony na ${ctx.args.count}.`,
          );
        },
      }),
      rename: defineSubcommand({
        description: "Zmienia nazwę twojego kanału",
        options: {
          name: { type: "string", description: "Nowa nazwa", required: true, rest: true },
        },
        run: async (ctx) => {
          const name = ctx.args.name.trim();
          if (name.length === 0) throw new UserError("Podaj nową nazwę kanału.");
          if ([...name].length > MAX_NAME_LENGTH) {
            throw new UserError(`Nazwa może mieć najwyżej ${MAX_NAME_LENGTH} znaków.`);
          }
          const { channel, reason } = await controlledChannel(ctx, "rename");
          if (await overRenameLimit(channel.channelId)) {
            throw new UserError("Discord pozwala zmienić nazwę 2 razy na 10 minut.");
          }
          await permissions.rename(channel.channelId, name, reason);
          await ownerReply(ctx, channel, "rename", `Nazwa kanału zmieniona na „${name}”.`);
        },
      }),
      invite: defineSubcommand({
        description: "Wpuszcza wskazaną osobę na twój kanał, nawet zamknięty lub ukryty",
        options: {
          user: { type: "user", description: "Kogo zaprosić", required: true },
        },
        run: async (ctx) => {
          const { channel, reason } = await controlledChannel(ctx, "invite");
          await pickMember(ctx, ctx.args.user);
          await permissions.allowMember(channel.channelId, ctx.args.user, reason);
          await ownerReply(ctx, channel, "invite", `<@${ctx.args.user}> może wejść na kanał.`);
        },
      }),
      block: defineSubcommand({
        description: "Blokuje wskazaną osobę na twoim kanale i wyrzuca ją, jeśli tam jest",
        options: {
          user: { type: "user", description: "Kogo zablokować", required: true },
        },
        run: async (ctx) => {
          const { channel, reason } = await controlledChannel(ctx, "block");
          const userId = ctx.args.user;
          if (userId === channel.ownerId) {
            throw new UserError("Nie można zablokować właściciela kanału.");
          }
          const member = await pickMember(ctx, userId);
          if (member.moderator) throw new UserError("Nie możesz zablokować moderatora.");
          await permissions.denyMember(channel.channelId, userId, reason);
          if ((await channels.members(channel.channelId))?.includes(userId)) {
            await permissions.disconnect(guildOf(ctx.guildId), userId, channel.channelId, reason);
          }
          await ownerReply(ctx, channel, "block", `<@${userId}> jest zablokowany na kanale.`);
        },
      }),
      hide: defineSubcommand({
        description: "Ukrywa twój kanał na liście",
        run: async (ctx) => {
          const { channel, reason } = await controlledChannel(ctx, "hide");
          await permissions.setEveryone(channel.channelId, { view: false }, reason);
          await ownerReply(ctx, channel, "hide", "Kanał ukryty.");
        },
      }),
      show: defineSubcommand({
        description: "Pokazuje twój kanał na liście",
        run: async (ctx) => {
          const { channel, reason } = await controlledChannel(ctx, "show");
          const { view } = await permissions.inheritedEveryone(channel.channelId);
          await permissions.setEveryone(channel.channelId, { view }, reason);
          await ownerReply(ctx, channel, "show", "Kanał znów widoczny.");
        },
      }),
    },
  });

  /**
   * The party channel the caller is in, provided they own it or have Manage Channels on it, plus the
   * audit-log reason for the edit. Counts against the member's control cooldown.
   */
  async function controlledChannel(
    ctx: CommandContext,
    action: string,
  ): Promise<{ channel: PartyChannel; reason: string }> {
    const guildId = guildOf(ctx.guildId);
    await enforceControlCooldown(guildId, ctx.user.id);
    const here = await channels.voiceChannelOf(guildId, ctx.user.id);
    const channel = here ? await repository.findChannel(here) : null;
    if (!channel || channel.guildId !== guildId) {
      throw new UserError("Musisz być na swoim kanale party.");
    }
    if (
      channel.ownerId !== ctx.user.id &&
      !(await permissions.canManage(guildId, ctx.user.id, channel.channelId))
    ) {
      throw new UserError("Tylko właściciel kanału może to zrobić.");
    }
    return { channel, reason: `Party: ${action} by ${ctx.user.id}` };
  }

  /** Counts a control command; fails open when Redis is down. */
  async function enforceControlCooldown(guildId: string, userId: string): Promise<void> {
    let count: number;
    try {
      ({ count } = await lock.increment(`party-ctl:${guildId}:${userId}`, CONTROL_WINDOW_MS));
    } catch (error) {
      logger.warn("Party control cooldown unavailable", { guildId, userId, error });
      return;
    }
    if (count > MAX_CONTROLS) {
      throw new UserError("Za dużo zmian naraz. Spróbuj ponownie za chwilę.");
    }
  }

  /** Counts a rename of the channel; fails open when Redis is down. */
  async function overRenameLimit(channelId: string): Promise<boolean> {
    try {
      const { count } = await lock.increment(`party-rename:${channelId}`, RENAME_WINDOW_MS);
      return count > MAX_RENAMES;
    } catch (error) {
      logger.warn("Party rename counter unavailable", { channelId, error });
      return false;
    }
  }

  /** Refuses the caller, the bot and people who are not on the server. */
  async function pickMember(ctx: CommandContext, userId: string): Promise<GuildMemberInfo> {
    if (userId === ctx.user.id) throw new UserError("Nie możesz zrobić tego sam sobie.");
    const member = await permissions.lookupMember(guildOf(ctx.guildId), userId);
    if (!member) throw new UserError("Nie ma takiej osoby na tym serwerze.");
    if (member.self) throw new UserError("Tego nie zrobię botowi.");
    return member;
  }

  /** Logs the finished control action, then tells the caller. */
  async function ownerReply(
    ctx: CommandContext,
    channel: PartyChannel,
    action: string,
    content: string,
  ): Promise<void> {
    logger.info("Party control used", {
      guildId: channel.guildId,
      channelId: channel.channelId,
      actor: ctx.user.id,
      action,
    });
    await ctx.reply({ content, ephemeral: true });
  }

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
      if (await repository.transferOwner(leftChannelId, owned.ownerId, candidate)) {
        logger.info("Party channel ownership transferred", {
          channelId: leftChannelId,
          from: owned.ownerId,
          to: candidate,
        });
        await moveOwnerAccess(leftChannelId, owned.ownerId, candidate);
        return;
      }
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

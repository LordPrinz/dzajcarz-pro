import type { CommandContext, LocaleResolver, Logger, Reply, Scheduler } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";

export interface PartyArea {
  guildId: string;
  categoryId: string;
  joinChannelId: string;
  /** Name of the area's new channels; `{user}` becomes the member's display name. */
  nameTemplate: string;
  /** Whether the area wants a command channel: the text chat of the join channel, with a panel. */
  commandChannel: boolean;
  /** The control panel message in that chat; null until one is posted. */
  panelMessageId: string | null;
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
  addArea(area: Omit<PartyArea, "panelMessageId">): Promise<void>;
  /** Changes the settings of an area; false when the area is gone. */
  updateArea(
    joinChannelId: string,
    settings: Pick<PartyArea, "nameTemplate" | "commandChannel">,
  ): Promise<boolean>;
  /** Remembers (or with null forgets) the panel message; false when the area is gone. */
  setPanelMessage(joinChannelId: string, messageId: string | null): Promise<boolean>;
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
  /**
   * Ids of the people (bots excluded) in the voice channel; null when the channel no longer exists, undefined
   * when nobody can tell yet because Discord has not sent the guild's voice states (guild unavailable).
   */
  members(channelId: string): Promise<string[] | null | undefined>;
  /** Whether the channel still exists on Discord. */
  exists(channelId: string): Promise<boolean>;
  /** Creates a category and the voice channel inside it that members join. Leaves nothing behind on failure. */
  createCategoryWithJoinChannel(
    guildId: string,
    categoryName: string,
    joinChannelName: string,
  ): Promise<{ categoryId: string; joinChannelId: string }>;
  /** Current names of an area's two channels; null when either is gone. */
  areaNames(
    categoryId: string,
    joinChannelId: string,
  ): Promise<{ categoryName: string; joinChannelName: string } | null>;
  /** Renames the category and the join channel (a name that already matches is left alone). */
  renameArea(
    categoryId: string,
    joinChannelId: string,
    names: { categoryName: string; joinChannelName: string },
  ): Promise<void>;
  /** The voice channel the member is in right now, or null when they are in none. */
  voiceChannelOf(guildId: string, userId: string): Promise<string | null>;
}

/**
 * The text chat of an area's join voice channel, where the panel lives. Every method rejects when Discord
 * refuses (no access, no Manage Messages). A message that is already gone counts as deleted.
 */
export interface PartyChat {
  /** Posts the message and returns its id. */
  post(channelId: string, message: Reply): Promise<string>;
  exists(channelId: string, messageId: string): Promise<boolean>;
  /** The most recent messages (up to 100), newest first. */
  recentMessages(channelId: string): Promise<ChatMessage[]>;
  deleteMessages(channelId: string, messageIds: string[]): Promise<void>;
  /** The bot's own user id, to tell its messages from members'. Undefined before the client is ready. */
  selfId(): string | undefined;
}

/** What the cleanup needs to know about a message to decide whether to spare it. */
export interface ChatMessage {
  id: string;
  authorId: string;
  pinned: boolean;
  /** Joins, pins, boosts and the like: Discord does not let bots delete some of them. */
  system: boolean;
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
  /** An application account: it can be locked out like anyone, but never receives a special invite. */
  bot: boolean;
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
  /** Whether the member is blocked on the channel (their own overwrite denies Connect, as `denyMember` sets it). */
  isBlocked(channelId: string, userId: string): Promise<boolean>;
  /** Removes the member's own overwrite. */
  clearMember(channelId: string, userId: string, reason: string): Promise<void>;
  /** 0 means no limit. */
  setLimit(channelId: string, limit: number, reason: string): Promise<void>;
  rename(channelId: string, name: string, reason: string): Promise<void>;
  /** The channel's current name. */
  channelName(channelId: string): Promise<string>;
  /** Kicks the member out of voice, but only while they are in `channelId`. */
  disconnect(guildId: string, userId: string, channelId: string, reason: string): Promise<void>;
  /** Null when the user is not a member of the guild. */
  lookupMember(guildId: string, userId: string): Promise<GuildMemberInfo | null>;
  /** Whether the member has Manage Channels on that very channel (overwrites included). */
  canManage(guildId: string, userId: string, channelId: string): Promise<boolean>;
}

/** What the invite shows about its sender and place. */
export interface InviteDescription {
  channelName: string;
  guildName: string;
  /** The sender's account name (without the @) and avatar picture. */
  inviterUsername: string;
  inviterAvatarUrl: string;
}

/** Direct messages for special invites. The methods reject on a Discord failure other than closed DMs. */
export interface PartyInvites {
  /** Names and avatar the invite shows. */
  describe(channelId: string, inviterId: string): Promise<InviteDescription>;
  /**
   * Downloads an uploaded file once, to attach it to every invite. Only Discord's own CDN is contacted, the
   * download is cut off at `maxBytes` and after a timeout. Null when it did not work.
   */
  downloadFile(url: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Sends the message (with its `files`) in a DM; false when the member's DMs are closed to the bot. */
  sendDirect(userId: string, message: Reply): Promise<boolean>;
}

/** Guild-wide facts about a member, which a channel overwrite cannot change. */
export interface PartyGuild {
  /** The permission bits the member holds in the guild itself; 0n when they are not a member. */
  memberPermissions(guildId: string, userId: string): Promise<bigint>;
}

export interface PartyModuleDeps {
  repository: PartyRepository;
  channels: PartyChannels;
  permissions: PartyPermissions;
  guild: PartyGuild;
  chat: PartyChat;
  invites: PartyInvites;
  /** Delays the cleanup of command channel messages. */
  scheduler: Scheduler;
  /** The join lock and the creation cooldown. */
  lock: Pick<KeyValueStore, "get" | "setIfAbsent" | "delIfEquals" | "increment">;
  /** The server's language for the panel, the member's for special invite DMs. */
  locales: LocaleResolver;
  logger: Logger;
}

/** What the owner controls need from whoever triggers them: a command, a button, a select or a form. */
export type ControlContext = Pick<CommandContext, "guildId" | "user" | "reply" | "locale">;

/** Why a special invite skips someone: a key of the module's catalog. */
export type SkipReason =
  | "skipRecipientLimit"
  | "skipLimitUnchecked"
  | "skipSelf"
  | "skipMissing"
  | "skipBot"
  | "skipBlocked"
  | "skipCheckFailed"
  | "skipNoAccess";

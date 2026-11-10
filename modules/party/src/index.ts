import {
  type BotModule,
  type CommandContext,
  defineButton,
  defineCommand,
  defineEvent,
  defineModal,
  defineSubcommand,
  defineUserSelect,
  type Logger,
  MODAL_MAX_TEXT,
  type ModalFile,
  PUBLIC_OWNER,
  type Reply,
  type ReplyFile,
  type Scheduler,
  UserError,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import type { Channel, Client, VoiceState } from "discord.js";

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
  /** Ids of the people (bots excluded) in the voice channel; null when the channel no longer exists. */
  members(channelId: string): Promise<string[] | null>;
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
}

/** What the cleanup needs to know about a message to decide whether to spare it. */
export interface ChatMessage {
  id: string;
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

export interface PartyModuleDeps {
  repository: PartyRepository;
  channels: PartyChannels;
  permissions: PartyPermissions;
  chat: PartyChat;
  invites: PartyInvites;
  /** Delays the cleanup of command channel messages. */
  scheduler: Scheduler;
  /** The join lock and the creation cooldown. */
  lock: Pick<KeyValueStore, "get" | "setIfAbsent" | "delIfEquals" | "increment">;
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
/** Each special invite is a DM to up to ten people: per owner 1 a minute and 5 an hour, and per recipient 3 an hour. */
const SPECIAL_MINUTE_MS = 60_000;
const SPECIAL_HOUR_MS = 3_600_000;
const SPECIAL_OWNER_PER_MINUTE = 1;
const SPECIAL_OWNER_PER_HOUR = 5;
const SPECIAL_RECIPIENT_PER_HOUR = 3;
const SPECIAL_MINUTE_MESSAGE =
  "Specjalne zaproszenie możesz wysłać raz na minutę. Spróbuj za chwilę.";
const SPECIAL_HOUR_MESSAGE = `Specjalne zaproszenia możesz wysłać najwyżej ${SPECIAL_OWNER_PER_HOUR} razy na godzinę.`;
const SPECIAL_UNAVAILABLE = "Specjalne zaproszenia są chwilowo niedostępne.";
const SPECIAL_MAX_MEMBERS = 10;
const SPECIAL_TITLE_MAX = 256;
/** Discord allows 4096 characters in an embed description; a modal text input stops at 4000. */
const SPECIAL_MESSAGE_MAX = Math.min(4096, MODAL_MAX_TEXT);
const SPECIAL_FILE_MAX_BYTES = 10 * 1_048_576;
const SPECIAL_FILE_TYPES = ["image/*", "video/*", "application/pdf"];
/** Formats Discord shows inline in an embed; any other file is attached under the embed. */
const EMBED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const SPECIAL_DEFAULT_COLOUR = "blue";
/** Colour of the invite embed by the option value of the form's select. */
const SPECIAL_COLOURS: Record<string, number> = {
  blue: 0x5865f2,
  red: 0xed4245,
  orange: 0xe67e22,
  yellow: 0xf1c40f,
  green: 0x57f287,
  purple: 0x9b59b6,
  pink: 0xeb459e,
  white: 0xffffff,
};
/** Discord's limit for channel and category names. */
const MAX_NAME_LENGTH = 100;
/** Longest template: leaves room for a display name before the 100 character cut. */
const MAX_TEMPLATE_LENGTH = 90;
const USER_PLACEHOLDER = "{user}";
const DEFAULT_TEMPLATE = `Kanał ${USER_PLACEHOLDER}`;
const DEFAULT_JOIN_CHANNEL_NAME = "➕ Dołącz, by stworzyć kanał";
/** Zero-width and other invisible format characters (\\p{Cf}); they would make a name look empty. */
const INVISIBLE = /\p{Cf}/gu;
/** Used when a template and display name leave nothing to name the channel with. */
const FALLBACK_CHANNEL_NAME = "Kanał imprezowy";

/** Modal state of a form that creates a new area (an edit carries the area's join channel id instead). */
const NEW_AREA = "new";

/** What the owner controls need from whoever triggers them: a command, a button, a select or a form. */
type ControlContext = Pick<CommandContext, "guildId" | "user" | "reply">;

const characters = (text: string): number => [...text].length;

/**
 * The name of a member's new channel: `{user}` replaced by their display name (whitespace collapsed),
 * cut to Discord's 100 characters, never empty.
 */
export function renderChannelName(template: string, displayName: string): string {
  const user = displayName.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const rendered = template
    .replaceAll(USER_PLACEHOLDER, () => user)
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...rendered].slice(0, MAX_NAME_LENGTH).join("").trim();
  return cut === "" ? FALLBACK_CHANNEL_NAME : cut;
}

/** Throws a UserError with a Polish message when the template cannot be used. */
export function validateTemplate(template: string): void {
  if (template.trim() === "") throw new UserError("Szablon nazwy nie może być pusty.");
  if (characters(template) > MAX_TEMPLATE_LENGTH) {
    throw new UserError(`Szablon nazwy może mieć najwyżej ${MAX_TEMPLATE_LENGTH} znaków.`);
  }
  if (!template.includes(USER_PLACEHOLDER)) {
    throw new UserError(
      `Szablon nazwy musi zawierać ${USER_PLACEHOLDER}, np. „${DEFAULT_TEMPLATE}”.`,
    );
  }
}

function validateName(label: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new UserError(`Podaj ${label}.`);
  if (characters(trimmed) > MAX_NAME_LENGTH) {
    throw new UserError(`Nazwa może mieć najwyżej ${MAX_NAME_LENGTH} znaków.`);
  }
  return trimmed;
}

/**
 * Longest prefix of `text` that fits `max` UTF-16 units (what the modal layer and Discord count) without
 * splitting a surrogate pair.
 */
function fitModalText(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

const PANEL_OUTDATED = "Ten panel jest nieaktualny. Poproś administratora o nowy.";
const PANEL_PROBLEM =
  "Nie udało się zaktualizować panelu w kanale komend. Sprawdź, czy bot może tam pisać i usuwać wiadomości.";

const COMMAND_CHANNEL_ON = "on";
const COMMAND_CHANNEL_OFF = "off";

/** Discord's user limit for a voice channel is 99; 0 removes it. */
const MAX_USER_LIMIT = 99;
/** Long enough to create a channel and move the member, short enough that a crash frees the lock fast. */
const LOCK_TTL_MS = 30_000;
/** A member may cause this many new channels per window; more joins are ignored (channel create/delete spam). */
const MAX_CREATIONS = 3;
const CREATION_WINDOW_MS = 60_000;
/** Reconciliation leaves younger channels alone: their owner may still be mid-join. */
const RECONCILE_GRACE_MS = 15_000;
/** Messages in a command channel (the panel excepted) are deleted this long after they appear. */
const CHAT_CLEANUP_MS = 15_000;
/** Messages that fall due within this window of each other are deleted in one request. */
const CLEANUP_BATCH_MS = 1_000;
/** A panel deleted again within this window is reposted only when it ends: bounds a loop against another bot or automod. */
const PANEL_REPOST_COOLDOWN_MS = 30_000;

export function createPartyModule({
  repository,
  channels,
  permissions,
  chat,
  invites,
  scheduler,
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
    commandChannels.delete(area.joinChannelId);
    for (const { channelId } of owned) await deleteQuietly(channelId);
    await deleteQuietly(area.joinChannelId);
    await deleteQuietly(area.categoryId);
    return owned.length;
  }

  /** Creates the category and join channel and stores the area; leaves nothing behind on failure. */
  async function createArea(
    guildId: string,
    settings: {
      categoryName: string;
      joinChannelName: string;
      nameTemplate: string;
      commandChannel: boolean;
    },
  ): Promise<string> {
    let created: { categoryId: string; joinChannelId: string };
    try {
      created = await channels.createCategoryWithJoinChannel(
        guildId,
        settings.categoryName,
        settings.joinChannelName,
      );
    } catch (error) {
      logger.warn("Party area not created on Discord", { guildId, error });
      throw new UserError(
        "Nie mogę utworzyć kanałów. Sprawdź, czy bot ma uprawnienia „Zarządzanie kanałami”, „Przenoszenie członków” i „Zarządzanie rolami” (nadpisania uprawnień).",
      );
    }
    try {
      await repository.addArea({
        guildId,
        ...created,
        nameTemplate: settings.nameTemplate,
        commandChannel: settings.commandChannel,
      });
    } catch (error) {
      await deleteQuietly(created.joinChannelId);
      await deleteQuietly(created.categoryId);
      throw error;
    }
    return created.joinChannelId;
  }

  /** Renames what changed, within the rename limit, and says precisely what happened. */
  async function renameAreaChannels(
    area: PartyArea,
    wanted: { categoryName: string; joinChannelName: string },
    guildId: string,
  ): Promise<string> {
    const saved = "Strefa imprezowa zaktualizowana.";
    const current = await channels.areaNames(area.categoryId, area.joinChannelId);
    if (!current) {
      return "Ustawienia zapisane, ale nie mogę odczytać kanałów tej strefy, więc ich nazw nie zmieniono.";
    }
    const changes = [
      {
        id: area.categoryId,
        changed: current.categoryName !== wanted.categoryName,
        done: "nazwę kategorii",
        notDone: "nazwy kategorii",
      },
      {
        id: area.joinChannelId,
        changed: current.joinChannelName !== wanted.joinChannelName,
        done: "nazwę kanału wejściowego",
        notDone: "nazwy kanału wejściowego",
      },
    ].filter((change) => change.changed);
    if (changes.length === 0) return saved;
    // Counted before touching Discord, so a refused rename never stalls on the API rate limit.
    const allowed: typeof changes = [];
    const limited: typeof changes = [];
    for (const change of changes) {
      if (await overRenameLimit(change.id)) limited.push(change);
      else allowed.push(change);
    }
    const names = (list: typeof changes, form: "done" | "notDone") =>
      list.map((change) => change[form]).join(" i ");
    let renamed: string | undefined;
    const problems: string[] = [];
    if (allowed.length > 0) {
      const renamesCategory = allowed.some((change) => change.id === area.categoryId);
      const renamesJoin = allowed.some((change) => change.id === area.joinChannelId);
      try {
        await channels.renameArea(area.categoryId, area.joinChannelId, {
          categoryName: renamesCategory ? wanted.categoryName : current.categoryName,
          joinChannelName: renamesJoin ? wanted.joinChannelName : current.joinChannelName,
        });
        renamed = names(allowed, "done");
      } catch (error) {
        logger.warn("Party area not renamed on Discord", { guildId, error });
        problems.push(
          `nie udało się zmienić ${names(allowed, "notDone")} (sprawdź uprawnienie „Zarządzanie kanałami”)`,
        );
      }
    }
    if (limited.length > 0) {
      problems.push(
        `${names(limited, "notDone")} nie zmieniono: Discord pozwala zmienić nazwę ${MAX_RENAMES} razy na 10 minut`,
      );
    }
    if (problems.length === 0) return saved;
    const done = renamed ? `, zmieniono ${renamed}` : "";
    return `Ustawienia zapisane${done}, ale ${problems.join("; ")}.`;
  }

  const createdMessage = (joinChannelId: string): string =>
    `Strefa imprezowa gotowa. Wejdź na <#${joinChannelId}>, a dostaniesz własny kanał głosowy.`;

  /** The form behind `/party create` (state `NEW_AREA`) and `/party edit` (state = the area's join channel). */
  const areaModal = defineModal({
    module: "party",
    name: "area",
    title: "Strefa imprezowa",
    permissions: MANAGE_CHANNELS,
    fields: {
      categoryName: {
        type: "short",
        label: "Nazwa kategorii",
        maxLength: MAX_NAME_LENGTH,
        placeholder: "Impreza",
      },
      joinChannelName: {
        type: "short",
        label: "Nazwa kanału wejściowego",
        maxLength: MAX_NAME_LENGTH,
        defaultValue: DEFAULT_JOIN_CHANNEL_NAME,
      },
      nameTemplate: {
        type: "short",
        label: "Szablon nazwy kanału",
        description: "{user} zamieni się w nazwę osoby, która wchodzi",
        maxLength: MAX_TEMPLATE_LENGTH,
        defaultValue: DEFAULT_TEMPLATE,
      },
      commandChannel: {
        type: "select",
        label: "Kanał komend",
        options: [
          { label: "Włączony", value: COMMAND_CHANNEL_ON },
          { label: "Wyłączony", value: COMMAND_CHANNEL_OFF },
        ],
        defaultValue: COMMAND_CHANNEL_OFF,
      },
    },
    run: async (ctx) => {
      const guildId = guildOf(ctx.guildId);
      const settings = {
        categoryName: validateName("nazwę kategorii", ctx.values.categoryName),
        joinChannelName: validateName("nazwę kanału wejściowego", ctx.values.joinChannelName),
        nameTemplate: ctx.values.nameTemplate,
        commandChannel: ctx.values.commandChannel === COMMAND_CHANNEL_ON,
      };
      validateTemplate(settings.nameTemplate);
      await ctx.defer();
      if (ctx.state === NEW_AREA) {
        const joinChannelId = await createArea(guildId, settings);
        const panelProblem = settings.commandChannel ? await syncPanel(joinChannelId) : null;
        await ctx.reply({
          content: [createdMessage(joinChannelId), panelProblem].filter(Boolean).join(" "),
          ephemeral: true,
        });
        return;
      }
      const area = await repository.findAreaByJoinChannel(ctx.state);
      if (!area || area.guildId !== guildId) {
        throw new UserError("Ta strefa już nie istnieje.");
      }
      // Settings first: a refused rename must not lose what the member just typed.
      if (
        !(await repository.updateArea(area.joinChannelId, {
          nameTemplate: settings.nameTemplate,
          commandChannel: settings.commandChannel,
        }))
      ) {
        throw new UserError("Ta strefa już nie istnieje.");
      }
      trackCommandChannel(area.joinChannelId, settings.commandChannel);
      // The panel follows the flag (posted when turned on, removed when turned off) before any rename.
      const panelProblem = await syncPanel(area.joinChannelId);
      const renamed = await renameAreaChannels(area, settings, guildId);
      await ctx.reply({
        content: [renamed, panelProblem].filter(Boolean).join(" "),
        ephemeral: true,
      });
    },
  });

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
            required: false,
            rest: true,
          },
        },
        run: async (ctx) => {
          const guildId = guildOf(ctx.guildId);
          if (ctx.canShowModal) {
            // The slash command is a form; a name typed into the option only prefills it.
            const categoryName =
              fitModalText(ctx.args.name?.trim() ?? "", MAX_NAME_LENGTH) || undefined;
            await ctx.showModal(areaModal.build(ctx.user.id, NEW_AREA, { categoryName }));
            return;
          }
          const categoryName = validateName("nazwę kategorii", ctx.args.name ?? "");
          await ctx.defer();
          const joinChannelId = await createArea(guildId, {
            categoryName,
            joinChannelName: DEFAULT_JOIN_CHANNEL_NAME,
            nameTemplate: DEFAULT_TEMPLATE,
            commandChannel: false,
          });
          await ctx.reply({ content: createdMessage(joinChannelId), ephemeral: true });
        },
      }),
      edit: defineSubcommand({
        description: "Zmienia nazwy i ustawienia strefy imprezowej w formularzu",
        permissions: MANAGE_CHANNELS,
        options: {
          channel: {
            type: "channel",
            description: "Kanał wejściowy strefy (gdy jest ich kilka)",
          },
        },
        run: async (ctx) => {
          const guildId = guildOf(ctx.guildId);
          if (!ctx.canShowModal) {
            throw new UserError("Edycja strefy wymaga komendy ukośnikowej: użyj /party edit.");
          }
          const area = await pickArea(guildId, ctx.args.channel, "do edycji");
          const names = await channels.areaNames(area.categoryId, area.joinChannelId);
          if (!names)
            throw new UserError(
              "Nie mogę odczytać kanałów tej strefy. Sprawdź, czy nie zostały usunięte.",
            );
          await ctx.showModal(
            areaModal.build(ctx.user.id, area.joinChannelId, {
              categoryName: fitModalText(names.categoryName, MAX_NAME_LENGTH),
              joinChannelName: fitModalText(names.joinChannelName, MAX_NAME_LENGTH),
              nameTemplate: fitModalText(area.nameTemplate, MAX_TEMPLATE_LENGTH),
              commandChannel: area.commandChannel ? COMMAND_CHANNEL_ON : COMMAND_CHANNEL_OFF,
            }),
          );
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
          const area = await pickArea(guildId, ctx.args.channel, "do usunięcia");
          await dismantleArea(area);
          await ctx.reply({ content: "Strefa imprezowa usunięta.", ephemeral: true });
        },
      }),
      lock: defineSubcommand({
        description: "Zamyka twój kanał dla nowych osób",
        run: (ctx) => lockChannel(ctx),
      }),
      unlock: defineSubcommand({
        description: "Otwiera twój kanał z powrotem",
        run: (ctx) => unlockChannel(ctx),
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
        run: (ctx) => limitChannel(ctx, ctx.args.count),
      }),
      rename: defineSubcommand({
        description: "Zmienia nazwę twojego kanału",
        options: {
          name: { type: "string", description: "Nowa nazwa", required: true, rest: true },
        },
        run: (ctx) => renameChannel(ctx, ctx.args.name),
      }),
      invite: defineSubcommand({
        description: "Wpuszcza wskazaną osobę na twój kanał, nawet zamknięty lub ukryty",
        options: {
          user: { type: "user", description: "Kogo zaprosić", required: true },
        },
        run: (ctx) => inviteMember(ctx, ctx.args.user),
      }),
      "invite-special": defineSubcommand({
        description: "Wysyła formularz-zaproszenie (wiadomość, załącznik) wybranym osobom",
        run: async (ctx) => {
          if (!ctx.canShowModal) {
            throw new UserError(
              "Specjalne zaproszenie wymaga komendy ukośnikowej: użyj /party invite-special.",
            );
          }
          await openSpecialInvite(ctx);
        },
      }),
      block: defineSubcommand({
        description: "Blokuje wskazaną osobę na twoim kanale i wyrzuca ją, jeśli tam jest",
        options: {
          user: { type: "user", description: "Kogo zablokować", required: true },
        },
        run: (ctx) => blockMember(ctx, ctx.args.user),
      }),
      hide: defineSubcommand({
        description: "Ukrywa twój kanał na liście",
        run: (ctx) => hideChannel(ctx),
      }),
      show: defineSubcommand({
        description: "Pokazuje twój kanał na liście",
        run: (ctx) => showChannel(ctx),
      }),
    },
  });

  const limitModal = defineModal({
    module: "party",
    name: "limit",
    title: "Limit osób",
    guildOnly: true,
    fields: {
      count: {
        type: "short",
        label: "Limit osób (0 = bez limitu)",
        placeholder: `0-${MAX_USER_LIMIT}`,
        maxLength: 2,
      },
    },
    run: async (ctx) => {
      if (!/^\d{1,2}$/.test(ctx.values.count)) {
        throw new UserError(`Limit osób to liczba od 0 do ${MAX_USER_LIMIT}.`);
      }
      await limitChannel(ctx, Number(ctx.values.count));
    },
  });

  const renameModal = defineModal({
    module: "party",
    name: "rename",
    title: "Zmień nazwę kanału",
    guildOnly: true,
    fields: {
      name: { type: "short", label: "Nowa nazwa", maxLength: MAX_NAME_LENGTH },
    },
    run: (ctx) => renameChannel(ctx, ctx.values.name),
  });

  const specialInviteModal = defineModal({
    module: "party",
    name: "invite-special",
    title: "Specjalne zaproszenie",
    guildOnly: true,
    fields: {
      members: {
        type: "user",
        label: `Kogo zaprosić (1-${SPECIAL_MAX_MEMBERS} osób)`,
        minValues: 1,
        maxValues: SPECIAL_MAX_MEMBERS,
      },
      title: {
        type: "short",
        label: "Tytuł",
        required: false,
        maxLength: SPECIAL_TITLE_MAX,
        placeholder: "Domyślnie: Zaproszenie na imprezę",
      },
      message: {
        type: "paragraph",
        label: "Wiadomość",
        required: false,
        maxLength: SPECIAL_MESSAGE_MAX,
        placeholder: "Domyślnie: krótkie zaproszenie na twój kanał",
      },
      colour: {
        type: "select",
        label: "Kolor",
        required: false,
        defaultValue: SPECIAL_DEFAULT_COLOUR,
        options: [
          { label: "Niebieski", value: "blue" },
          { label: "Czerwony", value: "red" },
          { label: "Pomarańczowy", value: "orange" },
          { label: "Żółty", value: "yellow" },
          { label: "Zielony", value: "green" },
          { label: "Fioletowy", value: "purple" },
          { label: "Różowy", value: "pink" },
          { label: "Biały", value: "white" },
        ],
      },
      attachment: {
        type: "file",
        label: "Załącznik",
        description:
          "Obraz, film lub PDF. Obraz pokaże się w zaproszeniu, reszta dojdzie jako plik.",
        required: false,
        contentTypes: SPECIAL_FILE_TYPES,
        maxBytes: SPECIAL_FILE_MAX_BYTES,
      },
    },
    run: (ctx) => sendSpecialInvites(ctx, ctx.values),
  });

  /** What a panel button does; the id is the button's custom_id state. */
  const PANEL_BUTTONS = {
    lock: { label: "Zamknij", emoji: "🔒", run: lockChannel },
    unlock: { label: "Otwórz", emoji: "🔓", run: unlockChannel },
    hide: { label: "Ukryj", emoji: "🙈", run: hideChannel },
    show: { label: "Pokaż", emoji: "👁️", run: showChannel },
  } as const;
  const PANEL_FORMS = {
    limit: { label: "Limit", emoji: "👥", modal: limitModal },
    rename: { label: "Zmień nazwę", emoji: "✏️", modal: renameModal },
    special: { label: "Specjalne zaproszenie", emoji: "💌", modal: specialInviteModal },
  } as const;
  const PANEL_USER_ACTIONS = {
    invite: { placeholder: "Zaproś osobę…", run: inviteMember },
    block: { placeholder: "Zablokuj osobę…", run: blockMember },
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
      throw new UserError(PANEL_OUTDATED);
    },
  });

  const panelUserSelect = defineUserSelect({
    module: "party",
    name: "panel-user",
    guildOnly: true,
    public: true,
    run: async (ctx) => {
      const userId = ctx.values[0];
      if (!isKey(PANEL_USER_ACTIONS, ctx.state) || !userId) throw new UserError(PANEL_OUTDATED);
      // Redrawing the panel clears the choice in the menu, so the next pick starts from the placeholder.
      await ctx.update(panelMessage());
      await PANEL_USER_ACTIONS[ctx.state].run(ctx, userId);
    },
  });

  /** The embed and controls in a command channel. Static, so any press can redraw it unchanged. */
  function panelMessage(): Reply {
    const buttons = { ...PANEL_BUTTONS, ...PANEL_FORMS };
    const button = (action: keyof typeof buttons) => ({
      type: "button" as const,
      customId: panelButton.customId(PUBLIC_OWNER, action),
      label: buttons[action].label,
      emoji: buttons[action].emoji,
    });
    const userSelect = (action: keyof typeof PANEL_USER_ACTIONS) => ({
      type: "user-select" as const,
      customId: panelUserSelect.customId(PUBLIC_OWNER, action),
      placeholder: PANEL_USER_ACTIONS[action].placeholder,
    });
    return {
      embeds: [
        {
          title: "Panel kanału party",
          description:
            "Przyciski sterują twoim kanałem głosowym: wejdź na niego i wybierz akcję. " +
            "„Specjalne zaproszenie” otwiera formularz z wiadomością i załącznikiem dla wybranych osób. " +
            "Odpowiedzi widzisz tylko ty, a wiadomości na tym czacie znikają po 15 sekundach.",
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
   * With `sweep` it also deletes the leftover messages, for startup. Returns null, or a Polish sentence
   * saying what failed, for the caller to show.
   */
  function syncPanel(joinChannelId: string, sweep = false): Promise<string | null> {
    return serialized(joinChannelId, async () => {
      try {
        const area = await repository.findAreaByJoinChannel(joinChannelId);
        if (!area) {
          commandChannels.delete(joinChannelId);
          return null;
        }
        trackCommandChannel(joinChannelId, area.commandChannel);
        if (!area.commandChannel) {
          await removePanel(area);
          return null;
        }
        const panelId = await ensurePanel(area);
        if (sweep && panelId) await deleteLeftovers(joinChannelId, panelId);
        return null;
      } catch (error) {
        logger.warn("Party panel not synced", { joinChannelId, error });
        return PANEL_PROBLEM;
      }
    });
  }

  /** The id of the area's panel, posting a new one when there is none or it was deleted. Null when the area is gone. */
  async function ensurePanel(area: PartyArea): Promise<string | null> {
    const { joinChannelId, panelMessageId } = area;
    if (panelMessageId && (await chat.exists(joinChannelId, panelMessageId))) return panelMessageId;
    const messageId = await chat.post(joinChannelId, panelMessage());
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

  /** Pinned and system messages are somebody's on purpose (or not ours to delete): the sweep leaves them. */
  async function deleteLeftovers(joinChannelId: string, panelId: string): Promise<void> {
    const stale = (await chat.recentMessages(joinChannelId))
      .filter((message) => message.id !== panelId && !message.pinned && !message.system)
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
      pinned?: boolean;
      system?: boolean;
    }) => {
      if (!message.guildId || !commandChannels.has(message.channelId)) return;
      // System messages (joins, pins) are not ours to delete, and a pinned one was kept on purpose.
      if (message.pinned || message.system) return;
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
          if ((await syncPanel(joinChannelId, true)) === null) restored++;
        } catch (error) {
          logger.warn("Could not restore a party panel", { joinChannelId, error });
        }
      }
      logger.info("Party panels restored", { restored });
    } catch (error) {
      logger.error("Party panel restore failed", { error });
    }
  }

  /*
   * The owner controls. Slash and prefix subcommands and the panel's buttons all call these, so a control
   * behaves the same wherever it was triggered. They need only who asked and a way to answer.
   */

  async function lockChannel(ctx: ControlContext): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "lock");
    await permissions.setEveryone(channel.channelId, { connect: false }, reason);
    await ownerReply(ctx, channel, "lock", "Kanał zamknięty. Wejdą tylko zaproszeni.");
  }

  async function unlockChannel(ctx: ControlContext): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "unlock");
    // Back to what the category says, so a private area stays private.
    const { connect } = await permissions.inheritedEveryone(channel.channelId);
    await permissions.setEveryone(channel.channelId, { connect }, reason);
    await ownerReply(ctx, channel, "unlock", "Kanał otwarty.");
  }

  async function hideChannel(ctx: ControlContext): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "hide");
    await permissions.setEveryone(channel.channelId, { view: false }, reason);
    await ownerReply(ctx, channel, "hide", "Kanał ukryty.");
  }

  async function showChannel(ctx: ControlContext): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "show");
    const { view } = await permissions.inheritedEveryone(channel.channelId);
    await permissions.setEveryone(channel.channelId, { view }, reason);
    await ownerReply(ctx, channel, "show", "Kanał znów widoczny.");
  }

  async function limitChannel(ctx: ControlContext, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0 || count > MAX_USER_LIMIT) {
      throw new UserError(`Limit osób to liczba od 0 do ${MAX_USER_LIMIT}.`);
    }
    const { channel, reason } = await controlledChannel(ctx, "limit");
    await permissions.setLimit(channel.channelId, count, reason);
    await ownerReply(
      ctx,
      channel,
      "limit",
      count === 0 ? "Limit osób usunięty." : `Limit osób ustawiony na ${count}.`,
    );
  }

  async function renameChannel(ctx: ControlContext, rawName: string): Promise<void> {
    const name = rawName.trim();
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
  }

  async function inviteMember(ctx: ControlContext, userId: string): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "invite");
    await pickMember(ctx, userId);
    await permissions.allowMember(channel.channelId, userId, reason);
    await ownerReply(ctx, channel, "invite", `<@${userId}> może wejść na kanał.`);
  }

  /** Only the owner may send special invites: they go out in the owner's name, so Manage Channels is not enough. */
  function requireOwner(ctx: ControlContext, channel: PartyChannel): void {
    if (channel.ownerId !== ctx.user.id) {
      throw new UserError("Tylko właściciel kanału może wysłać specjalne zaproszenie.");
    }
  }

  /** Refuses before the form opens, so nobody fills it in for nothing: not the owner, or over the owner limits. */
  async function checkSpecialAllowed(ctx: ControlContext, channel: PartyChannel): Promise<void> {
    requireOwner(ctx, channel);
    const guildId = guildOf(ctx.guildId);
    const minute = await specialCount(`party-special:min:${guildId}:${ctx.user.id}`);
    const hour = await specialCount(`party-special:hour:${guildId}:${ctx.user.id}`);
    if (minute >= SPECIAL_OWNER_PER_MINUTE) throw new UserError(SPECIAL_MINUTE_MESSAGE);
    if (hour >= SPECIAL_OWNER_PER_HOUR) throw new UserError(SPECIAL_HOUR_MESSAGE);
  }

  /** Refuses early (no channel, not the owner, limits) and opens the invite form. */
  async function openSpecialInvite(ctx: CommandContext): Promise<void> {
    const { channel } = await controlledChannel(ctx, "invite-special");
    await checkSpecialAllowed(ctx, channel);
    await ctx.showModal(specialInviteModal.build(ctx.user.id));
  }

  /** What the owner picked in the form, as the modal hands it over. */
  interface SpecialInviteForm {
    members: string[];
    title: string | undefined;
    message: string | undefined;
    colour: string | undefined;
    attachment: ModalFile | undefined;
  }

  /** Who got skipped and why, for the owner's summary. */
  type Skipped = { userId: string; reason: string };

  async function sendSpecialInvites(
    ctx: ControlContext & { defer(options?: { ephemeral?: boolean }): Promise<void> },
    form: SpecialInviteForm,
  ): Promise<void> {
    const guildId = guildOf(ctx.guildId);
    const channel = await ownChannel(ctx);
    requireOwner(ctx, channel);
    await takeSpecialAllowance(guildId, ctx.user.id);
    // Granting access and one DM per person takes longer than the three seconds Discord gives for a first
    // answer. Private, so a form opened from the panel shows its progress without touching the panel message.
    await ctx.defer({ ephemeral: true });

    const reason = `Party: invite-special by ${ctx.user.id}`;
    const { message, attachmentLost } = await specialInviteMessage(ctx, channel, form);
    const delivered: string[] = [];
    const dmFailed: string[] = [];
    const skipped: Skipped[] = [];

    for (const userId of new Set(form.members)) {
      const skip =
        (await specialSkipReason(ctx, channel, userId)) ?? (await recipientLimit(guildId, userId));
      if (skip) {
        skipped.push({ userId, reason: skip });
        continue;
      }
      try {
        await permissions.allowMember(channel.channelId, userId, reason);
      } catch (error) {
        logger.warn("Special invite could not grant access", {
          channelId: channel.channelId,
          userId,
          error,
        });
        skipped.push({ userId, reason: "nie udało się nadać dostępu" });
        continue;
      }
      try {
        const sent = await invites.sendDirect(userId, message);
        (sent ? delivered : dmFailed).push(userId);
      } catch (error) {
        logger.warn("Special invite DM failed", { channelId: channel.channelId, userId, error });
        dmFailed.push(userId);
      }
    }

    logger.info("Party special invite sent", {
      guildId,
      channelId: channel.channelId,
      actor: ctx.user.id,
      delivered: delivered.length,
      dmFailed: dmFailed.length,
      skipped: skipped.length,
    });
    await ctx.reply({
      content: specialSummary(delivered, dmFailed, skipped, attachmentLost),
      ephemeral: true,
    });
  }

  /** Why the member gets no invite, or null when they do. Never throws for a single member. */
  async function specialSkipReason(
    ctx: ControlContext,
    channel: PartyChannel,
    userId: string,
  ): Promise<string | null> {
    if (userId === ctx.user.id) return "to ty";
    try {
      const member = await permissions.lookupMember(guildOf(ctx.guildId), userId);
      if (!member) return "nie ma na serwerze";
      if (member.self || member.bot) return "to bot";
      if (await permissions.isBlocked(channel.channelId, userId)) {
        return "zablokowano na kanale";
      }
    } catch (error) {
      logger.warn("Special invite member check failed", {
        channelId: channel.channelId,
        userId,
        error,
      });
      return "nie udało się sprawdzić";
    }
    return null;
  }

  function specialSummary(
    delivered: string[],
    dmFailed: string[],
    skipped: Skipped[],
    attachmentLost: boolean,
  ): string {
    const mentions = (ids: string[]) => ids.map((id) => `<@${id}>`).join(", ");
    const lines: string[] = [];
    if (delivered.length > 0) {
      lines.push(`Zaproszenie dostarczone (${delivered.length}): ${mentions(delivered)}`);
    }
    if (dmFailed.length > 0) {
      lines.push(
        `Wiadomość prywatna nie doszła (${dmFailed.length}): ${mentions(dmFailed)}. ` +
          "Mimo to mogą wejść na kanał (dostęp zostaje), ale zaproszenia nie dostały: daj im znać sam.",
      );
    }
    if (skipped.length > 0) {
      const list = skipped.map(({ userId, reason }) => `<@${userId}> (${reason})`).join(", ");
      lines.push(`Pominięte (${skipped.length}): ${list}`);
    }
    if (attachmentLost) {
      lines.push("Załącznika nie udało się pobrać, zaproszenia poszły bez niego.");
    }
    return lines.join("\n");
  }

  /** The DM: the owner's text under an author line naming the sender, with a button to the channel. */
  async function specialInviteMessage(
    ctx: ControlContext,
    channel: PartyChannel,
    form: SpecialInviteForm,
  ): Promise<{ message: Reply; attachmentLost: boolean }> {
    let described: InviteDescription | null = null;
    try {
      described = await invites.describe(channel.channelId, ctx.user.id);
    } catch (error) {
      logger.warn("Special invite could not read channel names", {
        channelId: channel.channelId,
        error,
      });
    }
    const byline = described
      ? `Zaproszenie od ${ctx.user.displayName} (@${described.inviterUsername}) z serwera ${described.guildName}`
      : `Zaproszenie od ${ctx.user.displayName}`;

    const { attachment } = form;
    const file = attachment ? await specialFile(channel, attachment) : null;
    const isImage = file !== null && isEmbedImage(attachment?.contentType ?? null);
    return {
      attachmentLost: attachment !== undefined && file === null,
      message: {
        embeds: [
          {
            author: {
              name: byline.slice(0, 256),
              iconUrl: described?.inviterAvatarUrl,
            },
            title: form.title ?? "Zaproszenie na imprezę",
            description: form.message ?? `${ctx.user.displayName} zaprasza cię na swój kanał.`,
            color: SPECIAL_COLOURS[form.colour ?? SPECIAL_DEFAULT_COLOUR] ?? SPECIAL_COLOURS.blue,
            fields: [
              {
                name: "Kanał",
                value: (described?.channelName ?? "kanał party").slice(0, 100),
                inline: true,
              },
            ],
            footer: "Treść napisał zapraszający, nie bot.",
            image: isImage ? `attachment://${file.name}` : undefined,
          },
        ],
        files: file ? [file] : undefined,
        components: [
          [
            {
              type: "link",
              label: "Dołącz",
              url: `https://discord.com/channels/${channel.guildId}/${channel.channelId}`,
            },
          ],
        ],
      },
    };
  }

  function isEmbedImage(contentType: string | null): boolean {
    return EMBED_IMAGE_TYPES.includes(
      (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
    );
  }

  /** Downloads the owner's file once for all the invites; null (logged) when that fails. */
  async function specialFile(
    channel: PartyChannel,
    attachment: ModalFile,
  ): Promise<ReplyFile | null> {
    try {
      const data = await invites.downloadFile(attachment.url, SPECIAL_FILE_MAX_BYTES);
      if (!data) return null;
      // The name ends up in `attachment://<name>`, so only plain characters survive.
      const name = attachment.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100) || "plik";
      return { name, data };
    } catch (error) {
      logger.warn("Special invite attachment download failed", {
        channelId: channel.channelId,
        error,
      });
      return null;
    }
  }

  /** The value of a limit counter without counting; Redis down refuses, as the invites cannot be limited. */
  async function specialCount(key: string): Promise<number> {
    try {
      return Number(await lock.get(key)) || 0;
    } catch (error) {
      logger.warn("Party special invite limit unavailable", { key, error });
      throw new UserError(SPECIAL_UNAVAILABLE);
    }
  }

  /** Counts one use of a limit; Redis down refuses. */
  async function specialIncrement(key: string, windowMs: number): Promise<number> {
    try {
      return (await lock.increment(key, windowMs)).count;
    } catch (error) {
      logger.warn("Party special invite limit unavailable", { key, error });
      throw new UserError(SPECIAL_UNAVAILABLE);
    }
  }

  /** Counts a special invite against the owner's limits (1 a minute, 5 an hour). */
  async function takeSpecialAllowance(guildId: string, userId: string): Promise<void> {
    const minute = await specialIncrement(
      `party-special:min:${guildId}:${userId}`,
      SPECIAL_MINUTE_MS,
    );
    if (minute > SPECIAL_OWNER_PER_MINUTE) throw new UserError(SPECIAL_MINUTE_MESSAGE);
    const hour = await specialIncrement(`party-special:hour:${guildId}:${userId}`, SPECIAL_HOUR_MS);
    if (hour > SPECIAL_OWNER_PER_HOUR) throw new UserError(SPECIAL_HOUR_MESSAGE);
  }

  /** Counts an invite to one person; a reason to skip them when they already got 3 in the last hour. */
  async function recipientLimit(guildId: string, userId: string): Promise<string | null> {
    try {
      const { count } = await lock.increment(
        `party-special-to:${guildId}:${userId}`,
        SPECIAL_HOUR_MS,
      );
      return count > SPECIAL_RECIPIENT_PER_HOUR ? "limit zaproszeń dla tej osoby" : null;
    } catch (error) {
      logger.warn("Party special invite recipient limit unavailable", { guildId, userId, error });
      return "nie udało się sprawdzić limitu";
    }
  }

  async function blockMember(ctx: ControlContext, userId: string): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "block");
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
  }

  /** controlledChannel's checks (the cooldown aside), also used to refuse early before a form opens. */
  async function ownChannel(ctx: ControlContext): Promise<PartyChannel> {
    const guildId = guildOf(ctx.guildId);
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
    return channel;
  }

  /**
   * The party channel the caller is in, provided they own it or have Manage Channels on it, plus the
   * audit-log reason for the edit. Counts against the member's control cooldown.
   */
  async function controlledChannel(
    ctx: ControlContext,
    action: string,
  ): Promise<{ channel: PartyChannel; reason: string }> {
    await enforceControlCooldown(guildOf(ctx.guildId), ctx.user.id);
    const channel = await ownChannel(ctx);
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
  async function pickMember(ctx: ControlContext, userId: string): Promise<GuildMemberInfo> {
    if (userId === ctx.user.id) throw new UserError("Nie możesz zrobić tego sam sobie.");
    const member = await permissions.lookupMember(guildOf(ctx.guildId), userId);
    if (!member) throw new UserError("Nie ma takiej osoby na tym serwerze.");
    if (member.self) throw new UserError("Tego nie zrobię botowi.");
    return member;
  }

  /** Logs the finished control action, then tells the caller. */
  async function ownerReply(
    ctx: ControlContext,
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

  async function pickArea(
    guildId: string,
    joinChannelId: string | undefined,
    purpose: string,
  ): Promise<PartyArea> {
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
      throw new UserError(`Jest kilka stref (${list}). Wskaż kanał wejściowy strefy ${purpose}.`);
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
    const name = renderChannelName(area.nameTemplate, displayName);
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

  return {
    name: "party",
    commands: [party],
    components: [panelButton, panelUserSelect],
    modals: [areaModal, limitModal, renameModal, specialInviteModal],
    events: [leave, join, removed, reconcile, chatMessage, panelDeleted, panelBulkDeleted, panels],
    dispose() {
      for (const cancel of cleanups) cancel();
      cleanups.clear();
    },
  };
}

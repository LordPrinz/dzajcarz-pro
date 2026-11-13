import {
  defineCommand,
  defineModal,
  defineSubcommand,
  hasPermissions,
  type Locale,
  requireGuild,
  UserError,
} from "@dzajcarz/core";
import { MAX_NAME_LENGTH, MAX_RENAMES, MAX_TEMPLATE_LENGTH, MAX_USER_LIMIT } from "./constants.ts";
import type { createControls } from "./controls.ts";
import type { createLimits } from "./limits.ts";
import { t } from "./messages.ts";
import { fitModalText, validateName, validateTemplate } from "./naming.ts";
import type { createPanel } from "./panel.ts";
import type { createSpecialInvites } from "./special-invites.ts";
import type { PartyArea, PartyModuleDeps } from "./types.ts";

/** PermissionFlagsBits.ManageChannels; modules do not import discord.js at runtime. */
const MANAGE_CHANNELS = 1n << 4n;
/** Modal state of a form that creates a new area (an edit carries the area's join channel id instead). */
const NEW_AREA = "new";
const COMMAND_CHANNEL_ON = "on";
const COMMAND_CHANNEL_OFF = "off";

export function createAreas(
  { repository, channels, guild, logger }: PartyModuleDeps,
  limits: ReturnType<typeof createLimits>,
  controls: ReturnType<typeof createControls>,
  special: ReturnType<typeof createSpecialInvites>,
  panel: ReturnType<typeof createPanel>,
) {
  const { renameLimitReached, countRename } = limits;
  const {
    lockChannel,
    unlockChannel,
    hideChannel,
    showChannel,
    limitChannel,
    renameChannel,
    inviteMember,
    blockMember,
  } = controls;
  const { openSpecialInvite } = special;
  const { commandChannels, trackCommandChannel, syncPanel } = panel;

  /**
   * Areas are guild-wide, so Manage Channels must come from the member's guild-level roles: the command gate
   * also accepts a grant on a single channel, which would let that member dismantle any area.
   */
  async function requireGuildManageChannels(guildId: string, userId: string): Promise<void> {
    const granted = await guild.memberPermissions(guildId, userId);
    if (!hasPermissions(granted, MANAGE_CHANNELS)) {
      throw new UserError((l) => t(l).noGuildPermission);
    }
  }

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
    locale: Locale,
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
      throw new UserError(t(locale).createFailed);
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
    locale: Locale,
  ): Promise<string> {
    const saved = t(locale).areaSaved;
    const current = await channels.areaNames(area.categoryId, area.joinChannelId);
    if (!current) {
      return t(locale).areaUnreadable;
    }
    const changes = [
      {
        id: area.categoryId,
        changed: current.categoryName !== wanted.categoryName,
        kind: "category" as const,
      },
      {
        id: area.joinChannelId,
        changed: current.joinChannelName !== wanted.joinChannelName,
        kind: "join" as const,
      },
    ].filter((change) => change.changed);
    if (changes.length === 0) return saved;
    // Checked before touching Discord, so a refused rename never stalls on the API rate limit.
    const allowed: typeof changes = [];
    const limited: typeof changes = [];
    for (const change of changes) {
      if (await renameLimitReached(change.id)) limited.push(change);
      else allowed.push(change);
    }
    const names = (list: typeof changes, form: "done" | "notDone") =>
      list
        .map((change) =>
          (form === "done" ? t(locale).nameDone : t(locale).nameNotDone)(change.kind),
        )
        .join(t(locale).and);
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
        for (const change of allowed) await countRename(change.id);
        renamed = names(allowed, "done");
      } catch (error) {
        logger.warn("Party area not renamed on Discord", { guildId, error });
        problems.push(t(locale).renameFailed(names(allowed, "notDone")));
      }
    }
    if (limited.length > 0) {
      problems.push(t(locale).renameLimited(names(limited, "notDone"), MAX_RENAMES));
    }
    if (problems.length === 0) return saved;
    return t(locale).settingsSaved(renamed, problems.join("; "));
  }

  /** The form behind `/party create` (state `NEW_AREA`) and `/party edit` (state = the area's join channel). */
  const areaModal = defineModal({
    module: "party",
    name: "area",
    title: t.all("areaTitle"),
    permissions: MANAGE_CHANNELS,
    fields: {
      categoryName: {
        type: "short",
        label: t.all("categoryLabel"),
        maxLength: MAX_NAME_LENGTH,
        placeholder: t.all("categoryPlaceholder"),
      },
      joinChannelName: {
        type: "short",
        label: t.all("joinChannelLabel"),
        maxLength: MAX_NAME_LENGTH,
      },
      nameTemplate: {
        type: "short",
        label: t.all("templateLabel"),
        description: t.all("templateDescription"),
        maxLength: MAX_TEMPLATE_LENGTH,
      },
      commandChannel: {
        type: "select",
        label: t.all("commandChannelLabel"),
        options: [
          { label: t.all("commandChannelOn"), value: COMMAND_CHANNEL_ON },
          { label: t.all("commandChannelOff"), value: COMMAND_CHANNEL_OFF },
        ],
        defaultValue: COMMAND_CHANNEL_OFF,
      },
    },
    run: async (ctx) => {
      const guildId = requireGuild(ctx.guildId);
      await requireGuildManageChannels(guildId, ctx.user.id);
      const settings = {
        categoryName: validateName("category", ctx.values.categoryName),
        joinChannelName: validateName("join", ctx.values.joinChannelName),
        nameTemplate: ctx.values.nameTemplate,
        commandChannel: ctx.values.commandChannel === COMMAND_CHANNEL_ON,
      };
      validateTemplate(settings.nameTemplate);
      await ctx.defer();
      if (ctx.state === NEW_AREA) {
        const joinChannelId = await createArea(guildId, settings, ctx.locale);
        const panelProblem = settings.commandChannel && (await syncPanel(joinChannelId));
        await ctx.reply({
          content: [
            t(ctx.locale).areaReady(joinChannelId),
            panelProblem && t(ctx.locale).panelProblem,
          ]
            .filter(Boolean)
            .join(" "),
          ephemeral: true,
        });
        return;
      }
      const area = await repository.findAreaByJoinChannel(ctx.state);
      if (!area || area.guildId !== guildId) {
        throw new UserError((l) => t(l).areaGone);
      }
      // Settings first: a refused rename must not lose what the member just typed.
      if (
        !(await repository.updateArea(area.joinChannelId, {
          nameTemplate: settings.nameTemplate,
          commandChannel: settings.commandChannel,
        }))
      ) {
        throw new UserError((l) => t(l).areaGone);
      }
      trackCommandChannel(area.joinChannelId, settings.commandChannel);
      // The panel follows the flag (posted when turned on, removed when turned off) before any rename.
      const panelProblem = await syncPanel(area.joinChannelId);
      const renamed = await renameAreaChannels(area, settings, guildId, ctx.locale);
      await ctx.reply({
        content: [renamed, panelProblem && t(ctx.locale).panelProblem].filter(Boolean).join(" "),
        ephemeral: true,
      });
    },
  });

  const party = defineCommand({
    name: "party",
    description: t.all("partyDescription"),
    // No command-level permission: Discord would hide the owner controls from regular members.
    subcommands: {
      create: defineSubcommand({
        description: t.all("createDescription"),
        permissions: MANAGE_CHANNELS,
        options: {
          name: {
            type: "string",
            description: t.all("createNameOption"),
            required: false,
            rest: true,
          },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          await requireGuildManageChannels(guildId, ctx.user.id);
          if (ctx.canShowModal) {
            // The slash command is a form; a name typed into the option only prefills it.
            const categoryName =
              fitModalText(ctx.args.name?.trim() ?? "", MAX_NAME_LENGTH) || undefined;
            await ctx.showModal(
              areaModal.build(ctx.user.id, NEW_AREA, {
                categoryName,
                joinChannelName: t(ctx.locale).defaultJoinChannelName,
                nameTemplate: t(ctx.locale).defaultTemplate,
              }),
            );
            return;
          }
          const categoryName = validateName("category", ctx.args.name ?? "");
          await ctx.defer();
          const joinChannelId = await createArea(
            guildId,
            {
              categoryName,
              joinChannelName: t(ctx.locale).defaultJoinChannelName,
              nameTemplate: t(ctx.locale).defaultTemplate,
              commandChannel: false,
            },
            ctx.locale,
          );
          await ctx.reply({ content: t(ctx.locale).areaReady(joinChannelId), ephemeral: true });
        },
      }),
      edit: defineSubcommand({
        description: t.all("editDescription"),
        permissions: MANAGE_CHANNELS,
        options: {
          channel: {
            type: "channel",
            description: t.all("areaChannelOption"),
          },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          await requireGuildManageChannels(guildId, ctx.user.id);
          if (!ctx.canShowModal) {
            throw new UserError((l) => t(l).editNeedsSlash);
          }
          const area = await pickArea(guildId, ctx.args.channel, "edit");
          const names = await channels.areaNames(area.categoryId, area.joinChannelId);
          if (!names) throw new UserError((l) => t(l).areaChannelsMissing);
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
        description: t.all("deleteDescription"),
        permissions: MANAGE_CHANNELS,
        options: {
          channel: {
            type: "channel",
            description: t.all("areaChannelOption"),
          },
        },
        run: async (ctx) => {
          const guildId = requireGuild(ctx.guildId);
          await requireGuildManageChannels(guildId, ctx.user.id);
          await ctx.defer({ ephemeral: true });
          const area = await pickArea(guildId, ctx.args.channel, "delete");
          await dismantleArea(area);
          await ctx.reply({ content: t(ctx.locale).areaDeleted, ephemeral: true });
        },
      }),
      lock: defineSubcommand({
        description: t.all("lockDescription"),
        run: (ctx) => lockChannel(ctx),
      }),
      unlock: defineSubcommand({
        description: t.all("unlockDescription"),
        run: (ctx) => unlockChannel(ctx),
      }),
      limit: defineSubcommand({
        description: t.all("limitDescription"),
        options: {
          count: {
            type: "integer",
            description: t.all("limitOption"),
            required: true,
            minValue: 0,
            maxValue: MAX_USER_LIMIT,
          },
        },
        run: (ctx) => limitChannel(ctx, ctx.args.count),
      }),
      rename: defineSubcommand({
        description: t.all("renameDescription"),
        options: {
          name: { type: "string", description: t.all("renameOption"), required: true, rest: true },
        },
        run: (ctx) => renameChannel(ctx, ctx.args.name),
      }),
      invite: defineSubcommand({
        description: t.all("inviteDescription"),
        options: {
          user: { type: "user", description: t.all("inviteOption"), required: true },
        },
        run: (ctx) => inviteMember(ctx, ctx.args.user),
      }),
      "invite-special": defineSubcommand({
        description: t.all("inviteSpecialDescription"),
        run: async (ctx) => {
          if (!ctx.canShowModal) {
            throw new UserError((l) => t(l).inviteSpecialNeedsSlash);
          }
          await openSpecialInvite(ctx);
        },
      }),
      block: defineSubcommand({
        description: t.all("blockDescription"),
        options: {
          user: { type: "user", description: t.all("blockOption"), required: true },
        },
        run: (ctx) => blockMember(ctx, ctx.args.user),
      }),
      hide: defineSubcommand({
        description: t.all("hideDescription"),
        run: (ctx) => hideChannel(ctx),
      }),
      show: defineSubcommand({
        description: t.all("showDescription"),
        run: (ctx) => showChannel(ctx),
      }),
    },
  });

  async function pickArea(
    guildId: string,
    joinChannelId: string | undefined,
    purpose: "edit" | "delete",
  ): Promise<PartyArea> {
    if (joinChannelId !== undefined) {
      const area = await repository.findAreaByJoinChannel(joinChannelId);
      if (!area || area.guildId !== guildId) {
        throw new UserError((l) => t(l).notAreaEntrance);
      }
      return area;
    }
    const areas = await repository.listAreas(guildId);
    const [only] = areas;
    if (!only) throw new UserError((l) => t(l).noArea);
    if (areas.length > 1) {
      const list = areas.map((a) => `<#${a.joinChannelId}>`).join(", ");
      throw new UserError((l) => t(l).severalAreas(list, purpose));
    }
    return only;
  }

  return { deleteQuietly, dismantleArea, areaModal, party };
}

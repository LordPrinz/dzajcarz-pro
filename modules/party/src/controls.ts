import { characterCount, defineModal, requireGuild, UserError } from "@dzajcarz/core";
import { INVISIBLE, MAX_NAME_LENGTH, MAX_RENAMES, MAX_USER_LIMIT } from "./constants.ts";
import type { createLimits } from "./limits.ts";
import { t } from "./messages.ts";
import type { ControlContext, GuildMemberInfo, PartyChannel, PartyModuleDeps } from "./types.ts";

/**
 * Letters that render blank but are not format characters: Hangul fillers and the braille blank. Only the
 * rename check strips them; `renderChannelName` keeps its behaviour and its fallback name.
 */
const BLANK_FILLERS = /[\u115F\u1160\u3164\uFFA0\u2800]/gu;

export function createControls(
  { repository, channels, permissions, logger }: PartyModuleDeps,
  limits: ReturnType<typeof createLimits>,
) {
  const { enforceControlCooldown, renameLimitReached, countRename } = limits;

  const limitModal = defineModal({
    module: "party",
    name: "limit",
    title: t.all("limitTitle"),
    guildOnly: true,
    fields: {
      count: {
        type: "short",
        label: t.all("limitLabel"),
        placeholder: `0-${MAX_USER_LIMIT}`,
        maxLength: 2,
      },
    },
    run: async (ctx) => {
      if (!/^\d{1,2}$/.test(ctx.values.count)) {
        throw new UserError((l) => t(l).limitRange(MAX_USER_LIMIT));
      }
      await limitChannel(ctx, Number(ctx.values.count));
    },
  });

  const renameModal = defineModal({
    module: "party",
    name: "rename",
    title: t.all("renameTitle"),
    guildOnly: true,
    fields: {
      name: { type: "short", label: t.all("renameLabel"), maxLength: MAX_NAME_LENGTH },
    },
    run: (ctx) => renameChannel(ctx, ctx.values.name),
  });

  /*
   * The owner controls. Slash and prefix subcommands and the panel's buttons all call these, so a control
   * behaves the same wherever it was triggered. They need only who asked and a way to answer.
   */

  async function lockChannel(ctx: ControlContext): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "lock");
    await permissions.setEveryone(channel.channelId, { connect: false }, reason);
    await ownerReply(ctx, channel, "lock", t(ctx.locale).locked);
  }

  async function unlockChannel(ctx: ControlContext): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "unlock");
    // Back to what the category says, so a private area stays private.
    const { connect } = await permissions.inheritedEveryone(channel.channelId);
    await permissions.setEveryone(channel.channelId, { connect }, reason);
    await ownerReply(ctx, channel, "unlock", t(ctx.locale).unlocked);
  }

  async function hideChannel(ctx: ControlContext): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "hide");
    await permissions.setEveryone(channel.channelId, { view: false }, reason);
    await ownerReply(ctx, channel, "hide", t(ctx.locale).hidden);
  }

  async function showChannel(ctx: ControlContext): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "show");
    const { view } = await permissions.inheritedEveryone(channel.channelId);
    await permissions.setEveryone(channel.channelId, { view }, reason);
    await ownerReply(ctx, channel, "show", t(ctx.locale).shown);
  }

  async function limitChannel(ctx: ControlContext, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0 || count > MAX_USER_LIMIT) {
      throw new UserError((l) => t(l).limitRange(MAX_USER_LIMIT));
    }
    const { channel, reason } = await controlledChannel(ctx, "limit");
    await permissions.setLimit(channel.channelId, count, reason);
    await ownerReply(
      ctx,
      channel,
      "limit",
      count === 0 ? t(ctx.locale).limitRemoved : t(ctx.locale).limitSet(count),
    );
  }

  async function renameChannel(ctx: ControlContext, rawName: string): Promise<void> {
    const name = rawName.trim();
    if (name.length === 0) throw new UserError((l) => t(l).nameRequired);
    // Discord refuses a name without visible characters with a generic error, so say it here.
    if (name.replace(INVISIBLE, "").replace(BLANK_FILLERS, "").trim() === "") {
      throw new UserError((l) => t(l).nameInvisible);
    }
    if (characterCount(name) > MAX_NAME_LENGTH) {
      throw new UserError((l) => t(l).nameTooLong(MAX_NAME_LENGTH));
    }
    const { channel, reason } = await controlledChannel(ctx, "rename");
    if ((await permissions.channelName(channel.channelId)) === name) {
      await ownerReply(ctx, channel, "rename", t(ctx.locale).nameUnchanged(name));
      return;
    }
    if (await renameLimitReached(channel.channelId)) {
      throw new UserError((l) => t(l).renameRateLimit(MAX_RENAMES));
    }
    await permissions.rename(channel.channelId, name, reason);
    await countRename(channel.channelId);
    await ownerReply(ctx, channel, "rename", t(ctx.locale).renamed(name));
  }

  async function inviteMember(ctx: ControlContext, userId: string): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "invite");
    await pickMember(ctx, userId);
    await permissions.allowMember(channel.channelId, userId, reason);
    await ownerReply(ctx, channel, "invite", t(ctx.locale).invited(userId));
  }

  async function blockMember(ctx: ControlContext, userId: string): Promise<void> {
    const { channel, reason } = await controlledChannel(ctx, "block");
    if (userId === channel.ownerId) {
      throw new UserError((l) => t(l).cannotBlockOwner);
    }
    const member = await pickMember(ctx, userId);
    if (member.moderator) throw new UserError((l) => t(l).cannotBlockModerator);
    await permissions.denyMember(channel.channelId, userId, reason);
    if ((await channels.members(channel.channelId))?.includes(userId)) {
      await permissions.disconnect(requireGuild(ctx.guildId), userId, channel.channelId, reason);
    }
    await ownerReply(ctx, channel, "block", t(ctx.locale).blocked(userId));
  }

  /** controlledChannel's checks (the cooldown aside), also used to refuse early before a form opens. */
  async function ownChannel(ctx: ControlContext): Promise<PartyChannel> {
    const guildId = requireGuild(ctx.guildId);
    const here = await channels.voiceChannelOf(guildId, ctx.user.id);
    const channel = here ? await repository.findChannel(here) : null;
    if (!channel || channel.guildId !== guildId) {
      throw new UserError((l) => t(l).notInOwnChannel);
    }
    if (
      channel.ownerId !== ctx.user.id &&
      !(await permissions.canManage(guildId, ctx.user.id, channel.channelId))
    ) {
      throw new UserError((l) => t(l).ownerOnly);
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
    await enforceControlCooldown(requireGuild(ctx.guildId), ctx.user.id);
    const channel = await ownChannel(ctx);
    return { channel, reason: `Party: ${action} by ${ctx.user.id}` };
  }

  /** Refuses the caller, the bot and people who are not on the server. */
  async function pickMember(ctx: ControlContext, userId: string): Promise<GuildMemberInfo> {
    if (userId === ctx.user.id) throw new UserError((l) => t(l).notYourself);
    const member = await permissions.lookupMember(requireGuild(ctx.guildId), userId);
    if (!member) throw new UserError((l) => t(l).notOnServer);
    if (member.self) throw new UserError((l) => t(l).notTheBot);
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

  return {
    limitModal,
    renameModal,
    lockChannel,
    unlockChannel,
    hideChannel,
    showChannel,
    limitChannel,
    renameChannel,
    inviteMember,
    blockMember,
    ownChannel,
    controlledChannel,
  };
}

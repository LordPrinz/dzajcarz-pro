import {
  type CommandContext,
  defineModal,
  type Locale,
  MODAL_MAX_TEXT,
  type ModalFile,
  type Reply,
  type ReplyFile,
  requireGuild,
  UserError,
} from "@dzajcarz/core";
import {
  SPECIAL_MAX_MEMBERS,
  SPECIAL_OWNER_PER_HOUR,
  SPECIAL_OWNER_PER_MINUTE,
} from "./constants.ts";
import type { createControls } from "./controls.ts";
import type { createLimits } from "./limits.ts";
import { t } from "./messages.ts";
import type {
  ControlContext,
  InviteDescription,
  PartyChannel,
  PartyModuleDeps,
  SkipReason,
} from "./types.ts";

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

export function createSpecialInvites(
  { permissions, invites, locales, logger }: PartyModuleDeps,
  limits: ReturnType<typeof createLimits>,
  controls: ReturnType<typeof createControls>,
) {
  const { specialCount, takeSpecialAllowance, recipientLimitReached, countRecipient } = limits;
  const { ownChannel, controlledChannel } = controls;

  const specialInviteModal = defineModal({
    module: "party",
    name: "invite-special",
    title: t.all("specialTitle"),
    guildOnly: true,
    fields: {
      members: {
        type: "user",
        label: t.all("specialMembersLabel"),
        minValues: 1,
        maxValues: SPECIAL_MAX_MEMBERS,
      },
      title: {
        type: "short",
        label: t.all("specialTitleLabel"),
        required: false,
        maxLength: SPECIAL_TITLE_MAX,
        placeholder: t.all("specialTitlePlaceholder"),
      },
      message: {
        type: "paragraph",
        label: t.all("specialMessageLabel"),
        required: false,
        maxLength: SPECIAL_MESSAGE_MAX,
        placeholder: t.all("specialMessagePlaceholder"),
      },
      colour: {
        type: "select",
        label: t.all("specialColourLabel"),
        required: false,
        defaultValue: SPECIAL_DEFAULT_COLOUR,
        options: [
          { label: t.all("colourBlue"), value: "blue" },
          { label: t.all("colourRed"), value: "red" },
          { label: t.all("colourOrange"), value: "orange" },
          { label: t.all("colourYellow"), value: "yellow" },
          { label: t.all("colourGreen"), value: "green" },
          { label: t.all("colourPurple"), value: "purple" },
          { label: t.all("colourPink"), value: "pink" },
          { label: t.all("colourWhite"), value: "white" },
        ],
      },
      attachment: {
        type: "file",
        label: t.all("specialAttachmentLabel"),
        description: t.all("specialAttachmentDescription"),
        required: false,
        contentTypes: SPECIAL_FILE_TYPES,
        maxBytes: SPECIAL_FILE_MAX_BYTES,
      },
    },
    run: (ctx) => sendSpecialInvites(ctx, ctx.values),
  });

  /** Only the owner may send special invites: they go out in the owner's name, so Manage Channels is not enough. */
  function requireOwner(ctx: ControlContext, channel: PartyChannel): void {
    if (channel.ownerId !== ctx.user.id) {
      throw new UserError((l) => t(l).specialOwnerOnly);
    }
  }

  /** Refuses before the form opens, so nobody fills it in for nothing: not the owner, or over the owner limits. */
  async function checkSpecialAllowed(ctx: ControlContext, channel: PartyChannel): Promise<void> {
    requireOwner(ctx, channel);
    const guildId = requireGuild(ctx.guildId);
    const minute = await specialCount(`party-special:min:${guildId}:${ctx.user.id}`);
    const hour = await specialCount(`party-special:hour:${guildId}:${ctx.user.id}`);
    if (minute >= SPECIAL_OWNER_PER_MINUTE) throw new UserError((l) => t(l).specialMinute);
    if (hour >= SPECIAL_OWNER_PER_HOUR)
      throw new UserError((l) => t(l).specialHour(SPECIAL_OWNER_PER_HOUR));
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
  type Skipped = { userId: string; reason: SkipReason };

  async function sendSpecialInvites(
    ctx: ControlContext & { defer(options?: { ephemeral?: boolean }): Promise<void> },
    form: SpecialInviteForm,
  ): Promise<void> {
    const guildId = requireGuild(ctx.guildId);
    const channel = await ownChannel(ctx);
    requireOwner(ctx, channel);
    await takeSpecialAllowance(guildId, ctx.user.id);
    // Granting access and one DM per person takes longer than the three seconds Discord gives for a first
    // answer. Private, so a form opened from the panel shows its progress without touching the panel message.
    await ctx.defer({ ephemeral: true });

    const reason = `Party: invite-special by ${ctx.user.id}`;
    const { messageIn, attachmentLost } = await specialInviteMessage(ctx, channel, form);
    const delivered: string[] = [];
    const dmFailed: string[] = [];
    const skipped: Skipped[] = [];

    for (const userId of new Set(form.members)) {
      const skip =
        (await specialSkipReason(ctx, channel, userId)) ??
        (await recipientLimitReached(guildId, userId));
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
        skipped.push({ userId, reason: "skipNoAccess" });
        continue;
      }
      try {
        const sent = await invites.sendDirect(userId, messageIn(await locales.user(userId)));
        (sent ? delivered : dmFailed).push(userId);
        if (sent) await countRecipient(guildId, userId);
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
      content: specialSummary(ctx.locale, delivered, dmFailed, skipped, attachmentLost),
      ephemeral: true,
    });
  }

  /** Why the member gets no invite, or null when they do. Never throws for a single member. */
  async function specialSkipReason(
    ctx: ControlContext,
    channel: PartyChannel,
    userId: string,
  ): Promise<SkipReason | null> {
    if (userId === ctx.user.id) return "skipSelf";
    try {
      const member = await permissions.lookupMember(requireGuild(ctx.guildId), userId);
      if (!member) return "skipMissing";
      if (member.self || member.bot) return "skipBot";
      if (await permissions.isBlocked(channel.channelId, userId)) {
        return "skipBlocked";
      }
    } catch (error) {
      logger.warn("Special invite member check failed", {
        channelId: channel.channelId,
        userId,
        error,
      });
      return "skipCheckFailed";
    }
    return null;
  }

  function specialSummary(
    locale: Locale,
    delivered: string[],
    dmFailed: string[],
    skipped: Skipped[],
    attachmentLost: boolean,
  ): string {
    const mentions = (ids: string[]) => ids.map((id) => `<@${id}>`).join(", ");
    const lines: string[] = [];
    if (delivered.length > 0) {
      lines.push(t(locale).summaryDelivered(delivered.length, mentions(delivered)));
    }
    if (dmFailed.length > 0) {
      lines.push(t(locale).summaryDmFailed(dmFailed.length, mentions(dmFailed)));
    }
    if (skipped.length > 0) {
      const list = skipped
        .map(({ userId, reason }) => `<@${userId}> (${t(locale)[reason]})`)
        .join(", ");
      lines.push(t(locale).summarySkipped(skipped.length, list));
    }
    if (attachmentLost) {
      lines.push(t(locale).summaryAttachmentLost);
    }
    return lines.join("\n");
  }

  /**
   * The DM, built once per language of the recipients: the owner's text under an author line naming the
   * sender, with a button to the channel. The channel names and the file are fetched once for all of them.
   */
  async function specialInviteMessage(
    ctx: ControlContext,
    channel: PartyChannel,
    form: SpecialInviteForm,
  ): Promise<{ messageIn: (locale: Locale) => Reply; attachmentLost: boolean }> {
    let described: InviteDescription | null = null;
    try {
      described = await invites.describe(channel.channelId, ctx.user.id);
    } catch (error) {
      logger.warn("Special invite could not read channel names", {
        channelId: channel.channelId,
        error,
      });
    }
    const byline = (locale: Locale) =>
      described
        ? t(locale).dmBylineFrom(
            ctx.user.displayName,
            described.inviterUsername,
            described.guildName,
          )
        : t(locale).dmByline(ctx.user.displayName);

    const { attachment } = form;
    const file = attachment ? await specialFile(channel, attachment) : null;
    const isImage = file !== null && isEmbedImage(attachment?.contentType ?? null);
    return {
      attachmentLost: attachment !== undefined && file === null,
      messageIn: (locale) => ({
        embeds: [
          {
            author: {
              name: byline(locale).slice(0, 256),
              iconUrl: described?.inviterAvatarUrl,
            },
            title: form.title ?? t(locale).dmTitle,
            description: form.message ?? t(locale).dmDescription(ctx.user.displayName),
            color: SPECIAL_COLOURS[form.colour ?? SPECIAL_DEFAULT_COLOUR] ?? SPECIAL_COLOURS.blue,
            fields: [
              {
                name: t(locale).dmChannelField,
                value: (described?.channelName ?? t(locale).dmChannelFallback).slice(0, 100),
                inline: true,
              },
            ],
            footer: t(locale).dmFooter,
            image: isImage ? `attachment://${file.name}` : undefined,
          },
        ],
        files: file ? [file] : undefined,
        components: [
          [
            {
              type: "link",
              label: t(locale).dmJoin,
              url: `https://discord.com/channels/${channel.guildId}/${channel.channelId}`,
            },
          ],
        ],
      }),
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
      const name = attachment.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100) || "file";
      return { name, data };
    } catch (error) {
      logger.warn("Special invite attachment download failed", {
        channelId: channel.channelId,
        error,
      });
      return null;
    }
  }

  return { specialInviteModal, checkSpecialAllowed, openSpecialInvite };
}

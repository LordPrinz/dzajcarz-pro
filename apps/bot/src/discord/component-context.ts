import type { ComponentContext, ResolvedComponent } from "@dzajcarz/core";
import { type ButtonInteraction, MessageFlags, type StringSelectMenuInteraction } from "discord.js";
import { NO_MENTIONS, toReplyPayload } from "./reply.ts";

/** A click on a button or a choice in a select menu, as a module handler sees it. */
export function contextFromComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  resolved: ResolvedComponent,
): ComponentContext {
  // How the click was answered decides where `update` lands:
  // "update" and "defer" make the interaction response the clicked message (editReply edits it);
  // "reply" made it a separate ephemeral message, so the clicked message is edited through the webhook.
  let answer: "none" | "update" | "reply" = "none";
  return {
    state: resolved.state,
    values: interaction.isStringSelectMenu() ? interaction.values : [],
    user: { id: interaction.user.id, displayName: interaction.user.displayName },
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    memberPermissions: interaction.inGuild()
      ? (interaction.memberPermissions?.bitfield ?? 0n)
      : null,
    get acknowledged() {
      return answer !== "none";
    },
    async update(reply) {
      const { content, embeds, components } = toReplyPayload(reply);
      const payload = {
        content: content ?? null,
        embeds,
        components,
        allowedMentions: NO_MENTIONS,
      };
      if (answer === "none") {
        await interaction.update(payload);
        answer = "update";
      } else if (answer === "reply") {
        await interaction.webhook.editMessage(interaction.message.id, payload);
      } else {
        await interaction.editReply(payload);
      }
    },
    async defer() {
      if (answer !== "none") return;
      await interaction.deferUpdate();
      answer = "update";
    },
    async reply(reply) {
      const base = typeof reply === "string" ? { content: reply } : reply;
      const { content, embeds, components, ephemeral } = toReplyPayload({
        ...base,
        ephemeral: base.ephemeral ?? true,
      });
      const payload = { content, embeds, components, allowedMentions: NO_MENTIONS };
      const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
      if (answer === "none") {
        await interaction.reply({ ...payload, flags });
        answer = "reply";
      } else {
        await interaction.followUp({ ...payload, flags });
      }
    },
  };
}

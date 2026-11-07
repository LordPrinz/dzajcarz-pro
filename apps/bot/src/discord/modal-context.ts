import type { ModalBaseContext } from "@dzajcarz/core";
import { MessageFlags, type ModalSubmitInteraction } from "discord.js";
import { placeOf } from "./context.ts";
import { NO_MENTIONS, toReplyPayload } from "./reply.ts";

/** A submitted modal, as a module handler sees it (before the answers are parsed into `values`). */
export function contextFromModal(
  interaction: ModalSubmitInteraction,
  state: string,
): ModalBaseContext {
  // "update" and "defer" on a modal opened from a message edit that message; otherwise the first answer
  // is an ordinary (ephemeral) reply and later ones are follow-ups.
  let answer: "none" | "update" | "reply" = "none";
  return {
    state,
    user: { id: interaction.user.id, displayName: interaction.user.displayName },
    canUpdate: interaction.isFromMessage(),
    guildId: interaction.guildId,
    place: placeOf(interaction.context, interaction.guildId),
    channelId: interaction.channelId ?? "",
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
      if (answer === "none" && interaction.isFromMessage()) {
        await interaction.update(payload);
        answer = "update";
      } else if (answer === "update") {
        await interaction.editReply(payload);
      } else if (answer === "reply" && interaction.message) {
        await interaction.webhook.editMessage(interaction.message.id, payload);
      } else {
        throw new Error("update() works only on a modal opened from a message component");
      }
    },
    async defer() {
      if (answer !== "none") return;
      if (interaction.isFromMessage()) {
        await interaction.deferUpdate();
        answer = "update";
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        answer = "reply";
      }
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

import {
  type ButtonSpec,
  type ComponentContext,
  type ComponentRow,
  type ResolvedComponent,
  validateRows,
} from "@dzajcarz/core";
import {
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type ButtonInteraction,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type StringSelectMenuInteraction,
} from "discord.js";
import { NO_MENTIONS, toReplyPayload } from "./reply.ts";

export type ComponentRows = APIActionRowComponent<APIComponentInMessageActionRow>[];

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
} as const satisfies Record<NonNullable<ButtonSpec["style"]>, ButtonStyle>;

/** Plain-data rows from a module to the JSON Discord expects. Throws if the rows break a Discord limit. */
export function toComponentRows(rows: readonly ComponentRow[] = []): ComponentRows {
  validateRows(rows);
  return rows.map((row) => ({
    type: ComponentType.ActionRow,
    components: row.map((spec): APIComponentInMessageActionRow => {
      const emoji = spec.type === "select" || !spec.emoji ? undefined : { name: spec.emoji };
      if (spec.type === "link") {
        return {
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          url: spec.url,
          label: spec.label,
          emoji,
          disabled: spec.disabled,
        };
      }
      if (spec.type === "button") {
        return {
          type: ComponentType.Button,
          style: BUTTON_STYLES[spec.style ?? "secondary"],
          custom_id: spec.customId,
          label: spec.label,
          emoji,
          disabled: spec.disabled,
        };
      }
      return {
        type: ComponentType.StringSelect,
        custom_id: spec.customId,
        placeholder: spec.placeholder,
        min_values: spec.minValues,
        max_values: spec.maxValues,
        disabled: spec.disabled,
        options: spec.options.map((option) => ({
          label: option.label,
          value: option.value,
          description: option.description,
          default: option.default,
          emoji: option.emoji ? { name: option.emoji } : undefined,
        })),
      };
    }),
  }));
}

/** A click on a button or a choice in a select menu, as a module handler sees it. */
export function contextFromComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  resolved: ResolvedComponent,
): ComponentContext {
  return {
    state: resolved.state,
    values: interaction.isStringSelectMenu() ? interaction.values : [],
    user: { id: interaction.user.id, displayName: interaction.user.displayName },
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    memberPermissions: interaction.inGuild()
      ? (interaction.memberPermissions?.bitfield ?? 0n)
      : null,
    async update(reply) {
      const { content, embeds, components } = toReplyPayload(reply);
      const payload = {
        content: content ?? null,
        embeds,
        components,
        allowedMentions: NO_MENTIONS,
      };
      // The first answer to a click may edit the message in place; later ones go through the webhook.
      if (interaction.replied || interaction.deferred) await interaction.editReply(payload);
      else await interaction.update(payload);
    },
    async reply(reply) {
      const { content, embeds, components, ephemeral } = toReplyPayload({
        ephemeral: true,
        ...(typeof reply === "string" ? { content: reply } : reply),
      });
      const payload = { content, embeds, components, allowedMentions: NO_MENTIONS };
      const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
      if (interaction.replied || interaction.deferred)
        await interaction.followUp({ ...payload, flags });
      else await interaction.reply({ ...payload, flags });
    },
  };
}

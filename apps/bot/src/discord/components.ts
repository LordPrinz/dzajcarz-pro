import { type ButtonSpec, type ComponentRow, validateRows } from "@dzajcarz/core";
import {
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  ButtonStyle,
  ComponentType,
} from "discord.js";

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

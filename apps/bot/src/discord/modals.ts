import type { AnyModal, ModalRawValues } from "@dzajcarz/core";
import {
  type ModalChannelKind,
  type ModalFieldSpec,
  type ModalSpec,
  validateModal,
} from "@dzajcarz/core";
import {
  type APIComponentInLabel,
  type APIModalInteractionResponseCallbackData,
  ChannelType,
  ComponentType,
  type ModalSubmitInteraction,
  SelectMenuDefaultValueType,
  TextInputStyle,
} from "discord.js";

const CHANNEL_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  category: ChannelType.GuildCategory,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
} as const satisfies Record<ModalChannelKind, ChannelType>;

/** Plain-data modal from a module to the JSON Discord expects. Throws if it breaks a Discord limit. */
export function toModalPayload(spec: ModalSpec): APIModalInteractionResponseCallbackData {
  validateModal(spec);
  return {
    custom_id: spec.customId,
    title: spec.title,
    components: spec.fields.map((field) => ({
      type: ComponentType.Label,
      label: field.label,
      description: field.description,
      component: toFieldComponent(field),
    })),
  };
}

function toFieldComponent(field: ModalFieldSpec): APIComponentInLabel {
  const base = {
    custom_id: field.customId,
    placeholder: field.placeholder,
    required: field.required,
  };
  switch (field.type) {
    case "short":
    case "paragraph":
      return {
        ...base,
        type: ComponentType.TextInput,
        style: field.type === "short" ? TextInputStyle.Short : TextInputStyle.Paragraph,
        min_length: field.minLength,
        max_length: field.maxLength,
        value: field.value,
      };
    case "channel":
      return {
        ...base,
        type: ComponentType.ChannelSelect,
        min_values: field.required ? 1 : 0,
        max_values: 1,
        channel_types: field.channelTypes?.map((kind) => CHANNEL_TYPES[kind]),
        default_values: field.value
          ? [{ id: field.value, type: SelectMenuDefaultValueType.Channel }]
          : undefined,
      };
    case "user":
      return {
        ...base,
        type: ComponentType.UserSelect,
        min_values: field.required ? 1 : 0,
        max_values: 1,
        default_values: field.value
          ? [{ id: field.value, type: SelectMenuDefaultValueType.User }]
          : undefined,
      };
  }
}

/** The raw answers of a submit, keyed by the modal's field ids; core validates and types them. */
export function readModalValues(
  modal: AnyModal,
  interaction: ModalSubmitInteraction,
): ModalRawValues {
  const raw: Record<string, string | readonly string[] | undefined> = {};
  for (const key of Object.keys(modal.fields)) {
    const field = interaction.fields.fields.get(key);
    if (field && "value" in field && typeof field.value === "string") raw[key] = field.value;
    else if (field && "values" in field) raw[key] = field.values;
  }
  return raw;
}

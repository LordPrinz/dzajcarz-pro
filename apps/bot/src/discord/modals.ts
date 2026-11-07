import type { AnyModal, ModalRawValues } from "@dzajcarz/core";
import {
  type ChannelFieldDef,
  type ModalChannelKind,
  type ModalFieldSpec,
  type ModalSpec,
  REJECTED_MODAL_VALUE,
  validateModal,
} from "@dzajcarz/core";
import {
  type APIComponentInLabel,
  type APIModalInteractionResponseCallbackData,
  ChannelType,
  ComponentType,
  type ModalSubmitInteraction,
  SelectMenuDefaultValueType,
  type SelectMenuModalData,
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

/**
 * The raw answers of a submit, keyed by the modal's field ids; core validates and types them. The payload is
 * untrusted, so a value is passed on only when the submitted component is of the type the field declares and,
 * for selects, the id is among the entities Discord resolved (a channel also of an allowed type and, in a
 * guild, of that guild). Anything else becomes `REJECTED_MODAL_VALUE`.
 */
export function readModalValues(
  modal: AnyModal,
  interaction: ModalSubmitInteraction,
): ModalRawValues {
  const raw: Record<string, string | readonly string[] | undefined> = {};
  for (const [key, def] of Object.entries(modal.fields)) {
    const field = interaction.fields.fields.get(key);
    if (!field) continue;
    if (def.type === "short" || def.type === "paragraph") {
      if (field.type !== ComponentType.TextInput) raw[key] = REJECTED_MODAL_VALUE;
      else if (typeof field.value === "string") raw[key] = field.value;
    } else if (def.type === "channel") {
      if (field.type !== ComponentType.ChannelSelect) raw[key] = REJECTED_MODAL_VALUE;
      else raw[key] = field.values.map((id) => acceptChannel(def, field, id, interaction));
    } else if (field.type !== ComponentType.UserSelect) {
      raw[key] = REJECTED_MODAL_VALUE;
    } else {
      raw[key] = field.values.map((id) => (field.users?.has(id) ? id : REJECTED_MODAL_VALUE));
    }
  }
  return raw;
}

function acceptChannel(
  def: ChannelFieldDef,
  field: SelectMenuModalData,
  id: string,
  interaction: ModalSubmitInteraction,
): string {
  const channel = field.channels?.get(id);
  if (!channel) return REJECTED_MODAL_VALUE;
  const allowed: ChannelType[] | undefined = def.channelTypes?.map((kind) => CHANNEL_TYPES[kind]);
  if (allowed && !allowed.includes(channel.type)) return REJECTED_MODAL_VALUE;
  const channelGuild = "guildId" in channel ? channel.guildId : null;
  if (interaction.guildId && channelGuild && channelGuild !== interaction.guildId) {
    return REJECTED_MODAL_VALUE;
  }
  return id;
}

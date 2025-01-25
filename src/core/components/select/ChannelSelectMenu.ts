import {
  ChannelSelectMenuBuilder,
  ComponentType,
  type Interaction,
  type BaseSelectMenuComponentData,
  type InteractionResponse,
  type MessageComponentCollectorOptions,
  type ChannelSelectMenuInteraction,
} from 'discord.js';

type Props = Omit<
  Omit<
    BaseSelectMenuComponentData & {
      interaction: Interaction;
    },
    'customId'
  >,
  'type'
>;

export const ChannelSelectMenu = ({ interaction, ...props }: Props) =>
  new ChannelSelectMenuBuilder({
    customId: interaction.id,
    type: ComponentType.ChannelSelect,
    ...props,
  });

type Params = {
  reply: InteractionResponse<boolean>;
  interaction: Interaction;
} & Omit<MessageComponentCollectorOptions<ChannelSelectMenuInteraction>, 'componentType'>;

export const createChannelSelectMenuCollector = ({ reply, interaction, time, ...props }: Params) =>
  reply.createMessageComponentCollector({
    componentType: ComponentType.ChannelSelect,
    filter: (i) => i.customId === interaction.id && i.user.id === interaction.user.id,

    time: time || 60000,
    ...props,
  });

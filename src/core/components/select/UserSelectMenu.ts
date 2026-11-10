import {
  UserSelectMenuBuilder,
  ComponentType,
  type Interaction,
  type BaseSelectMenuComponentData,
  type InteractionResponse,
  type MessageComponentCollectorOptions,
  type UserSelectMenuInteraction,
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

export const UserSelectMenu = ({ interaction, ...props }: Props) =>
  new UserSelectMenuBuilder({
    customId: interaction.id,
    type: ComponentType.UserSelect,
    ...props,
  });

type Params = {
  reply: InteractionResponse<boolean>;
  interaction: Interaction;
} & Omit<MessageComponentCollectorOptions<UserSelectMenuInteraction>, 'componentType'>;

export const createUserSelectMenuCollector = ({ reply, interaction, time, ...props }: Params) =>
  reply.createMessageComponentCollector({
    componentType: ComponentType.UserSelect,
    filter: (i) => i.customId === interaction.id && i.user.id === interaction.user.id,

    time: time || 60000,
    ...props,
  });

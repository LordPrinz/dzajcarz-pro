import {
  RoleSelectMenuBuilder,
  ComponentType,
  type Interaction,
  type BaseSelectMenuComponentData,
  type InteractionResponse,
  type MessageComponentCollectorOptions,
  type RoleSelectMenuInteraction,
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

export const RoleSelectMenu = ({ interaction, ...props }: Props) =>
  new RoleSelectMenuBuilder({
    customId: interaction.id,
    type: ComponentType.RoleSelect,
    ...props,
  });

type Params = {
  reply: InteractionResponse<boolean>;
  interaction: Interaction;
} & Omit<MessageComponentCollectorOptions<RoleSelectMenuInteraction>, 'componentType'>;

export const createRoleSelectMenuCollector = ({ reply, interaction, time, ...props }: Params) =>
  reply.createMessageComponentCollector({
    componentType: ComponentType.RoleSelect,
    filter: (i) => i.customId === interaction.id && i.user.id === interaction.user.id,

    time: time || 60000,
    ...props,
  });

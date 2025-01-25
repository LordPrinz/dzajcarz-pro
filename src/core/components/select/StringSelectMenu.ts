import {
  StringSelectMenuOptionBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  type SelectMenuComponentOptionData,
  type APISelectMenuOption,
  type InteractionResponse,
  type Interaction,
  type MessageComponentCollectorOptions,
  type StringSelectMenuInteraction,
  type BaseSelectMenuComponentData,
} from 'discord.js';

type Props = Omit<
  Omit<
    BaseSelectMenuComponentData & {
      interaction: Interaction;
      options: (SelectMenuComponentOptionData | APISelectMenuOption)[];
    },
    'customId'
  >,
  'type'
>;

export type StringSelectOptions = (SelectMenuComponentOptionData | APISelectMenuOption)[];

export const StringSelectMenu = ({ options, interaction, ...props }: Props) => {
  const selectMenu = new StringSelectMenuBuilder({
    customId: interaction.id,

    type: ComponentType.StringSelect,
    ...props,
  });

  selectMenu.addOptions(options.map((option) => new StringSelectMenuOptionBuilder(option)));

  return selectMenu;
};

type Params = {
  reply: InteractionResponse<boolean>;
  interaction: Interaction;
} & Omit<MessageComponentCollectorOptions<StringSelectMenuInteraction>, 'componentType'>;

export const createStringSelectMenuCollector = ({ reply, interaction, time, ...props }: Params) =>
  reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === interaction.id && i.user.id === interaction.user.id,

    time: time || 60000,
    ...props,
  });

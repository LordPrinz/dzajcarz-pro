import {
	StringSelectMenuOptionBuilder,
	StringSelectMenuBuilder,
	ComponentType,
	type SelectMenuComponentOptionData,
	type APISelectMenuOption,
	type StringSelectMenuComponentData,
	type APIStringSelectComponent,
	type InteractionResponse,
	type Interaction,
	type MessageComponentCollectorOptions,
	type StringSelectMenuInteraction,
} from "discord.js";

type Props = {
	interaction: Interaction;
	options: (SelectMenuComponentOptionData | APISelectMenuOption)[];
	maxValues?: number;
	minValues?: number;
} & Omit<
	Partial<StringSelectMenuComponentData | APIStringSelectComponent>,
	"customId"
>;

export const StringSelectMenu = ({
	options,
	interaction,

	...props
}: Omit<Props, "type">) => {
	const selectMenu = new StringSelectMenuBuilder({
		customId: interaction.id,

		type: ComponentType.StringSelect,
		...props,
	});

	selectMenu.addOptions(
		options.map((option) => new StringSelectMenuOptionBuilder(option))
	);

	return selectMenu;
};

type Params = {
	reply: InteractionResponse<boolean>;
	interaction: Interaction;
} & Omit<
	MessageComponentCollectorOptions<StringSelectMenuInteraction>,
	"componentType"
>;

export const createStringSelectMenuCollector = ({
	reply,
	interaction,
	time,
	...props
}: Params) =>
	reply.createMessageComponentCollector({
		componentType: ComponentType.StringSelect,
		filter: (i) =>
			i.customId === interaction.id && i.user.id === interaction.user.id,

		time: time || 60000,
		...props,
	});

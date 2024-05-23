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
	MessageCollectorOptionsParams,
	MessageComponentCollectorOptions,
	StringSelectMenuInteraction,
} from "discord.js";

type Props = {
	id?: string;
	options: (SelectMenuComponentOptionData | APISelectMenuOption)[];
} & Omit<
	Partial<StringSelectMenuComponentData | APIStringSelectComponent>,
	"customId"
>;

export const StringSelectMenu = ({
	options,
	id,
	...props
}: Omit<Props, "type">) => {
	const customId = id || `interaction--${crypto.randomUUID()}`;

	const selectMenu = new StringSelectMenuBuilder({
		customId,
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
} & MessageComponentCollectorOptions<StringSelectMenuInteraction>;

export const createStringSelectMenuCollector = ({
	reply,
	interaction,
	time,
}: Params) =>
	reply.createMessageComponentCollector({
		componentType: ComponentType.StringSelect,
		filter: (i) =>
			i.customId === interaction.id && i.user.id === interaction.user.id,
		time: time || 60000,
	});

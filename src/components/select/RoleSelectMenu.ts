import {
	RoleSelectMenuBuilder,
	ComponentType,
	type Interaction,
	type BaseSelectMenuComponentData,
	type SelectMenuComponentOptionData,
	type APISelectMenuOption,
	type InteractionResponse,
	type MessageComponentCollectorOptions,
	type RoleSelectMenuInteraction,
} from "discord.js";

type Props = Omit<
	Omit<
		BaseSelectMenuComponentData & {
			interaction: Interaction;
			options: (SelectMenuComponentOptionData | APISelectMenuOption)[];
		},
		"customId"
	>,
	"type"
>;

export const StringSelectMenu = ({ options, interaction, ...props }: Props) => {
	const selectMenu = new RoleSelectMenuBuilder({
		customId: interaction.id,
		type: ComponentType.RoleSelect,
		...props,
	});

	return selectMenu;
};

type Params = {
	reply: InteractionResponse<boolean>;
	interaction: Interaction;
} & Omit<
	MessageComponentCollectorOptions<RoleSelectMenuInteraction>,
	"componentType"
>;

export const createRoleSelectMenuCollector = ({
	reply,
	interaction,
	time,
	...props
}: Params) =>
	reply.createMessageComponentCollector({
		componentType: ComponentType.RoleSelect,
		filter: (i) =>
			i.customId === interaction.id && i.user.id === interaction.user.id,

		time: time || 60000,
		...props,
	});

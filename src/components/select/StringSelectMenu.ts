import {
	StringSelectMenuOptionBuilder,
	StringSelectMenuBuilder,
	type SelectMenuComponentOptionData,
	type APISelectMenuOption,
	type StringSelectMenuComponentData,
	type APIStringSelectComponent,
} from "discord.js";

type Props = {
	id?: string;
	options: (SelectMenuComponentOptionData | APISelectMenuOption)[];
} & Omit<
	Partial<StringSelectMenuComponentData | APIStringSelectComponent>,
	"customId"
>;

export const stringSelectMenu = ({ options, id, ...props }: Props) => {
	const selectMenu = new StringSelectMenuBuilder({
		customId: id,
		...props,
	});

	selectMenu.addOptions(
		options.map((option) => new StringSelectMenuOptionBuilder(option))
	);

	return selectMenu;
};

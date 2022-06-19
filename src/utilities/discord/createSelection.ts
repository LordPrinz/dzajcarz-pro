import {
	Message,
	MessageActionRow,
	MessageSelectMenu,
	MessageSelectOptionData,
} from "discord.js";

const createSelection = (
	message: Message,
	options: MessageSelectOptionData[]
) => {
	let row: MessageActionRow = message.components[0];

	if (!row) {
		row = new MessageActionRow();
	}

	const menu = row.components[0] as MessageSelectMenu;

	if (menu) {
		menu.addOptions(options);
		menu.setMaxValues(1);
	} else {
		row.addComponents(
			new MessageSelectMenu()
				.setCustomId("help")
				.setMinValues(0)
				.setMaxValues(1)
				.setPlaceholder("Select command category...")
				.addOptions(options)
		);
	}

	return row;
};

export default createSelection;

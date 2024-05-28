import { ActionRow } from "@/components";
import {
	ChannelSelectMenu,
	RoleSelectMenu,
	StringSelectMenu,
	createChannelSelectMenuCollector,
	createRoleSelectMenuCollector,
	createStringSelectMenuCollector,
} from "@/components/select";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Test command to test modals",
	type: CommandType.BOTH,
	testOnly: true,
	ownerOnly: true,
	guildOnly: true,

	callback: async ({ interaction }) => {
		// # String Select Menu

		// const selectMenu = StringSelectMenu({
		// 	placeholder: "Select an option",
		// 	interaction,

		// 	options: [
		// 		{
		// 			label: "Option 1",
		// 			value: "option_1",
		// 		},
		// 		{
		// 			label: "Option 2",
		// 			value: "option_2",
		// 		},
		// 	],
		// });

		// const actionRow = ActionRow(selectMenu);

		// const reply = await interaction.reply({
		// 	components: [actionRow],
		// });

		// const collector = createStringSelectMenuCollector({
		// 	reply,
		// 	interaction,
		// 	time: 60000,
		// });

		// collector.on("collect", (i) => {
		// 	if (!i.values.length) return;

		// 	i.reply(`You selected ${i.values.join(", ")}`);
		// });

		// # Role Select Menu

		// 	const roleSelect = RoleSelectMenu({
		// 		placeholder: "Select a role",
		// 		interaction,
		// 	});

		// 	const actionRow = ActionRow(roleSelect);

		// 	const reply = await interaction.reply({
		// 		components: [actionRow],
		// 	});

		// 	const collector = createRoleSelectMenuCollector({
		// 		reply,
		// 		interaction,
		// 	});

		// 	collector.on("collect", (i) => {
		// 		if (!i.values.length) return;

		// 		i.reply(`You selected ${i.values.join(", ")}`);
		// 	});

		// # Channel Select Menu

		const channelSelect = ChannelSelectMenu({
			placeholder: "Select a channel",
			interaction,
		});

		const actionRow = ActionRow(channelSelect);

		const reply = await interaction.reply({
			components: [actionRow],
		});

		const collector = createChannelSelectMenuCollector({
			reply,
			interaction,
		});

		collector.on("collect", (i) => {
			if (!i.values.length) return;

			i.reply(`You selected ${i.values.join(", ")}`);
		});
	},
} as CommandObject;

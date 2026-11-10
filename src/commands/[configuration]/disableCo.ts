import { CommandType, type CommandObject } from "wokcommands";
import { PermissionFlagsBits } from "discord.js";
import { appendElement, checkElementExists } from "@/helpers/redis/list";
import { disableCoFeature } from "@/db/coFeature";

export default {
	description: "Disables bot replies to 'co'",
	type: CommandType.BOTH,
	permissions: [PermissionFlagsBits.Administrator],
	guildOnly: true,

	callback: async ({ guild }) => {
		const guildId = guild.id;

		const isCoDisabled = await checkElementExists("coDisabledFeature", guildId);

		if (isCoDisabled) {
			return "Bot replies to 'co' are already disabled";
		}

		await appendElement("coDisabledFeature", guildId);
		await disableCoFeature(guildId);

		return "Bot replies to 'co' are now disabled";
	},
} as CommandObject;

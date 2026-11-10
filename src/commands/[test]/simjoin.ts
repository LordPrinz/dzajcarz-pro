import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Test command to simulate a member join",
	type: CommandType.BOTH,
	testOnly: true,
	ownerOnly: true,

	callback({ client, member }) {
		client.emit("guildMemberAdd", member);
		return "Simulated a member join event";
	},
} as CommandObject;

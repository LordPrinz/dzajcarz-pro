import { ICommand } from "wokcommands";
import partyAreaSchema from "../../models/party-area-schema";
import PartyArea from "../../../types/TPartyArea";

const deleteParty = {
	category: "Party",
	description: "Deletes the category.",
	slash: "both",
	minArgs: 1,
	expectedArgs: "<id>",
	expectedArgsTypes: ["CHANNEL"],
	permissions: ["MANAGE_CHANNELS"],
	options: [
		{
			name: "id",
			description: "Name of the category.",
			type: "STRING",
			required: true,
		},
	],

	callback: async ({ args, guild }) => {
		const categoryId = args[0];
		const category = guild?.channels.cache.find(
			(channel) => channel.id === categoryId
		);

		if (!category) {
			return "No category found.";
		}

		let partyData: PartyArea[];

		if (!partyData!) {
			const results: PartyArea[] = await partyAreaSchema.find({
				groupId: categoryId,
			});

			if (!results) {
				return;
			}

			partyData = results;
		}

		if (!partyData) {
			return "No category found.";
		}

		let message = "Could not delete the category.";

		partyData.map((data) => {
			if (data.groupId !== category.id) {
				return;
			}

			const channelsToDelete = guild?.channels.cache.filter(
				(channel) => channel.parentId === categoryId
			);

			channelsToDelete?.forEach((channel) => {
				channel.delete().catch((err) => {});
			});

			category.delete().catch((err) => {});

			message = "Party deleted successfully!";
		});
		try {
			return message;
		} catch (err) {}
	},
} as ICommand;

export default deleteParty;

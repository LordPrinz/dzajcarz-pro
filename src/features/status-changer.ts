import { ActivityType, type Client } from "discord.js";
import WOK from "wokcommands";

const statusOptions = [
	"Ein Heller",
	"und",
	"ein Batzen",
	"Die waren",
	"beide mein",
	"ja mein",
	"Der Heller",
	"ward zu Wasser",
	"Der Batzen",
	"ward zu Wein",
	"ja Wein",
	"Der Helle",
	"ward zu Wasser",
	"Der Batzen",
	"ward zu Wein",
	"HEILI",
	"HEILO",
	"HEILA",
	"HEILI",
	"HEILO",
	"HEILA",
	"HEILI",
	"HEILO",
	"HEILA",
	"HA HA HA HA HA HA HA",
	"HEILI",
	"HEILO",
	"HEILA",
	"HEILI",
	"HEILO",
	"HEILA",
	"HEILI",
	"HEILO",
	"HEILA",
];
const timeout = 1000 * 15;

export default async (_: WOK, client: Client) => {
	let counter = 0;

	const updateStatus = async (name: string, type: ActivityType) => {
		client.user?.setPresence({
			status: "online",
			activities: [
				{
					name,
					type,
				},
			],
		});

		if (++counter >= statusOptions.length) {
			counter = 0;
		}
	};

	setInterval(() => {
		updateStatus(statusOptions[counter], ActivityType.Listening);
	}, timeout);
};

import { Client } from "discord.js";

const timeout = 1000 * 15;

const statusChanger = (client: Client) => {
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
	let counter = 0;

	const updateStatus = () => {
		client.user?.setPresence({
			status: "online",
			activities: [
				{
					name: statusOptions[counter],
				},
			],
		});

		if (++counter >= statusOptions.length) {
			counter = 0;
		}

		setTimeout(updateStatus, timeout);
	};

	updateStatus();
};

export default statusChanger;

export const config = {
	dbName: "STATUS_CHANGER",
	displayName: "Status Changer",
};

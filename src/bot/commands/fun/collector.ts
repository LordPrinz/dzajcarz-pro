import { ICommand } from "wokcommands";
import generateInvitation from "../../../utils/commands/generateInvitation";
import { getRandom, sleep } from "../../../utils/oneLiners";
import Logger from "../../../utils/debug/Logger";

const collector = {
	category: "Fun",
	description: "Execution time",

	callback: ({ message, channel, member }) => {
		message?.reply("Podbij łapę jeśli chcesz bana");
		message?.react("👍");

		let hasBeenBanned = false;

		const time = 1000 * 60 * 60 * 24;

		const collector = message?.createReactionCollector({
			time,
		});

		const logger = new Logger();

		collector.on("collect", async (reaction, usr) => {
			const userId = usr.id;

			const userToBan = await reaction.message.guild?.members.fetch(userId);
			const message = reaction?.message;
			if (!userToBan?.bannable) {
				if (userToBan?.id === "935890396419096706") {
					return;
				}

				message?.reply("Nie mogę tego uczynić Panie...");
				return;
			}

			message?.reply(`Jak sobie życzysz <@${userId}>`);

			await sleep(3000);

			if (userId === member?.user?.id) {
				hasBeenBanned = true;
			}
			logger.saveLog(`BAN ${usr?.username}`, "info");

			message?.reply("No to elo xd");

			userToBan?.ban({
				reason: "Sam chciał Bana :)",
			});
		});

		collector.on("end", async () => {
			if (hasBeenBanned) {
				return;
			}

			if (!member.kickable) {
				return;
			}

			await sleep(3000);

			message?.reply("No cóż...");

			const isLucky = getRandom(0, 4) === 0;

			if (isLucky) {
				await sleep(3000);
				message?.reply("Masz szczęście :D");
				return;
			}

			const invitation = await generateInvitation(channel);

			await sleep(3000);

			message?.reply("Chyba wylatujsz");

			await sleep(3000);

			channel?.send("No to elo xd");

			await member
				?.send(`https://discord.gg/${invitation.code}`)
				.catch(() => {});
			logger.saveLog(`KICK ${member?.user?.username}`, "info");
			message?.member?.kick().catch(() => {});
		});
	},
} as ICommand;

export default collector;

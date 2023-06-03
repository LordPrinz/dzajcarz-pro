import { ICommand } from "wokcommands";
import generateInvitation from "../../utilities/discord/generateInvitation";
import { getRandom } from "../../../utils/oneLiners";
import { sleep } from "../../../utils/oneLiners";

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
			console.log(`BAN ${usr?.username}`);

			message?.reply("No to elo xd");

			userToBan
				?.ban({
					reason: "Sam chciał Bana :)",
				})
				.catch((err) => console.error(err));
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
			console.log(`KICK ${member?.user?.username}`);
			message?.member?.kick().catch(() => {});
		});
	},
} as ICommand;

export default collector;

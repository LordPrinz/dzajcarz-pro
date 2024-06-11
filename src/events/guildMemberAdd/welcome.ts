import { type TextChannel, type GuildMember } from "discord.js";

import { getOneByIDWelcomeChannel } from "@/db/welcomeChannel";
import { pingUser, replaceTagToUser } from "@/utils";

export default async (member: GuildMember) => {
	const { guild, id } = member;

	const data = await getOneByIDWelcomeChannel(guild.id);

	if (!data) return;

	const { channelId, content } = data;

	const channel = guild.channels.cache.get(channelId) as TextChannel;

	if (!channel) return;

	const welcomeMessage = replaceTagToUser(content, pingUser(id));

	channel.send(welcomeMessage);
};

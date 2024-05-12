import { type TextChannel, type GuildMember } from "discord.js";

import { getOneByIDWelcomeChannel } from "@/db/welcomeChannel";

export default async (member: GuildMember) => {
	const { guild, id } = member;

	const data = await getOneByIDWelcomeChannel(guild.id);

	if (!data) return;

	const { channelId, content } = data;

	const channel = guild.channels.cache.get(channelId) as TextChannel;

	if (!channel) return;

	channel.send(content.replace(/@/g, `<@${id}>`));
};

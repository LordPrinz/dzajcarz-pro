interface Scheduled {
	time: string[];
	song?: string;
	message?: string;
	userId?: string[];
	channelId?: string[];
	guildId?: string[];
	isOnline?: boolean;
}

export default Scheduled;

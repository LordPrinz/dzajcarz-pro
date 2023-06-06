import {
	DMChannel,
	Message,
	PartialDMChannel,
	PartialMessage,
} from "discord.js";

export const formMessage = (message: Message | PartialMessage) => {
	const content = message?.content;
	const attachments = message?.attachments;
	const author = message?.author;
	const timestamp = message?.createdTimestamp;
	const messageId = message.id;
	const avatar = author?.displayAvatarURL();
	const authorId = author?.id;
	const authorTag = author?.tag;
	const opponent = (message.channel as DMChannel | PartialDMChannel).recipient;
	const chat = authorId === process.env.CLIENT_ID ? opponent.id : authorId;

	const transformedAttachments: {
		name: string | null;
		url: string;
		size: number;
		proxyURL: string;
		height: number | null;
		width: number | null;
		contentType: string | null;
	}[] = attachments.map((attachment) => {
		return {
			_id: attachment.id,
			name: attachment.name,
			size: attachment.size,
			url: attachment.url,
			proxyURL: attachment.proxyURL,
			height: attachment.height,
			width: attachment.width,
			contentType: attachment.contentType,
		};
	});

	const msg = {
		_id: messageId,
		content,
		attachments: transformedAttachments,
		timestamp,
		author: {
			_id: authorId,
			avatar,
			tag: authorTag,
		},
		chat,
	};

	return msg;
};

export const isDmChannel = (message: Message | PartialMessage) =>
	message.channel.type === "DM";

export type TMessage = {
	id: string;
	content: string | null;
	attachments: {
		name: string | null;
		url: string;
		size: number;
		proxyURL: string;
		height: number | null;
		width: number | null;
		contentType: string | null;
	}[];
	timestamp: number;
	author: string | undefined;
	chat: string | undefined;
};

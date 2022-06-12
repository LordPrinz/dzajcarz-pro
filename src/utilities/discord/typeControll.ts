export const isInteration = (interaction: any): boolean => {
	if (!interaction) {
		return false;
	}
	return "type" in interaction && interaction?.type === "APPLICATION_COMMAND";
};

export const isMessage = (message: any): boolean => {
	if (!message) {
		return false;
	}
	return "author" in message && "content" in message;
};

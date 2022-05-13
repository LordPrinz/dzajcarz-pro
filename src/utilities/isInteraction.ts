const isInteration = (interaction: any): boolean => {
	if (!interaction) {
		return false;
	}
	return "type" in interaction && interaction?.type === "APPLICATION_COMMAND";
};

export default isInteration;

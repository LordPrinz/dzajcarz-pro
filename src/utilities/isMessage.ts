const isMessage = (message: any): boolean => {
	if (!message) {
		return false;
	}
	return "author" in message && "content" in message;
};

export default isMessage;

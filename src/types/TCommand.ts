type Command = {
	names: string[];
	category: string;
	description: string;
	syntax: string;
	hidden: boolean;
	testOnly: boolean;
};

export default Command;

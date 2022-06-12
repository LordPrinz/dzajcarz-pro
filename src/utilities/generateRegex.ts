const generateRegex = (word: string) => {
	const letters = word.toLowerCase().split("");
	let regexTemp = "^";
	letters.map((letter, index) => {
		regexTemp += `${letter}{1,}`;
		if (index < letters.length - 1) {
			regexTemp += "[\\s]*";
		}
	});
	regexTemp += "(?!.)|^";
	letters.map((letter, index) => {
		regexTemp += `${letter}{1,}[\\s]`;
		if (index < letters.length - 1) {
			regexTemp += "*";
		}
	});
	regexTemp += ".|.";

	letters.map((letter, index) => {
		regexTemp += `[\\s]`;
		if (index >= 1) {
			regexTemp += "*";
		}
		regexTemp += `${letter}{1,}`;
	});

	regexTemp += "(?=\\s)";

	regexTemp += "|.[\\s](";
	letters.map((letter, index) => {
		regexTemp += `${letter}{1,}`;
		if (letters.length - 1 !== index) {
			regexTemp += "[\\s]?";
		}
	});
	regexTemp += ")$";

	return new RegExp(regexTemp);
};

export default generateRegex;

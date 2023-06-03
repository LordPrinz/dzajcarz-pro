export const getRandom = (min: number, max: number): number => {
	min = Math.ceil(min);
	max = Math.floor(max);
	return Math.floor(Math.random() * (max - min + 1)) + min;
};

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const capitalizeFirstLetter = (string: string): string =>
	string.charAt(0).toUpperCase() + string.slice(1);

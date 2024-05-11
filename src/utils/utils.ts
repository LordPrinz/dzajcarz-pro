export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const capitalizeFirstLetter = (string: string): string =>
	string.charAt(0).toUpperCase() + string.slice(1);

export const isDivisible = (number: number, divider: number): boolean =>
	number % divider === 0;

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const capitalizeFirstLetter = (string: string): string =>
	string.charAt(0).toUpperCase() + string.slice(1);

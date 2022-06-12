export const isDivisible = (number: number, divider: number): boolean => {
	return number % divider === 0;
};

export const sleep = (ms: number) => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};

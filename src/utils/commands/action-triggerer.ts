import cron from "cron";

export const decodeScheduledTime = (time: string) => {
	const timeParts = time.split(" ");

	const hours = timeParts[0].split(":")[0] ?? "00";
	const minutes = timeParts[0].split(":")[1] ?? "00";
	const seconds = timeParts[0].split(":")[2] ?? "00";

	const dayOfMonth = timeParts[1] ?? "*";
	const months = timeParts[2] ?? "*";
	const dayOfWeek = timeParts[3] ?? "*";

	const decodedTime = `${seconds} ${minutes} ${hours} ${dayOfMonth} ${months} ${dayOfWeek}`;

	return decodedTime;
};

export const planAction = (time: string, callback: () => void) => {
	const scheduledAction = new cron.CronJob(time, callback);
	scheduledAction.start();
};

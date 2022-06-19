import cron from "cron";

const planAction = (time: string, callback: () => void) => {
	const scheduledAction = new cron.CronJob(time, callback);
	scheduledAction.start();
};

export default planAction;

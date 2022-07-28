import cron from "cron";

const planAction = (time: string, callback: () => void) => {
	try {
		const scheduledAction = new cron.CronJob(time, callback);
		scheduledAction.start();
	} catch {}
};

export default planAction;

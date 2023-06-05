import fs from "fs";
import { AppNames, LogType } from "../../types/TLogger";

/**
 * Log file managment class
 */

class Logger {
	private readonly filePath: string = "./logs.log";
	private timestamp: string = "";
	private appName: AppNames;

	constructor(appName: AppNames) {
		this.appName = appName;
	}

	/**
	 * Saves log to deticated log file.
	 * @param log Log message
	 * @param type A type of log e.g. ERROR, WARNING
	 */

	saveLog(log: string, type: LogType) {
		this.generateTimestamp();
		const logData = `${
			this.timestamp
		} ${type.toUpperCase()} ${this.appName.toUpperCase()} ${log} \n`;
		this.saveToFile(logData);
	}

	private generateTimestamp() {
		const date = new Date();
		const formattedDate = `${date.getFullYear()}-${this.padNumber(
			date.getMonth() + 1
		)}-${this.padNumber(date.getDate())} ${this.padNumber(
			date.getHours()
		)}:${this.padNumber(date.getMinutes())}:${this.padNumber(
			date.getSeconds()
		)}`;
		this.timestamp = formattedDate;
	}

	private padNumber(num: number): string {
		return num.toString().padStart(2, "0");
	}

	private saveToFile(log: string) {
		fs.writeFileSync(this.filePath, log, { encoding: "utf-8", flag: "a+" });
	}
}

export default Logger;

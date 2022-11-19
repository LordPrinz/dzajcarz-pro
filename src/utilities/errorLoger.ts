import fs from "fs";

export const createLog = (error: unknown) => {
	const logPath = "./error.log";

	const time = new Date().toUTCString();

	const log = `${time} | ${(error as any).name} -> ${(error as any).message}\r`;

	fs.writeFileSync(logPath, log, { encoding: "utf-8", flag: "a+" });
};

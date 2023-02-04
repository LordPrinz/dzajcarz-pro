import fs from "fs";

export const createErrorLog = (error: unknown) => {
	const logPath = "./error.log";

	const time = new Date().toUTCString();

	const log = `${time} | ${(error as any).name} -> ${(error as any).message}\r`;

	fs.writeFileSync(logPath, log, { encoding: "utf-8", flag: "a+" });
};

export const createWarningLog = (warning: unknown) => {
	const logPath = "./warning.log";

	const time = new Date().toUTCString();

	const log = `${time} | ${(warning as any).name} -> ${
		(warning as any).message
	}\r`;

	fs.writeFileSync(logPath, log, { encoding: "utf-8", flag: "a+" });
};

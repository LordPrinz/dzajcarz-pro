import fs from "fs";

const getFiles = (dir: fs.PathLike, suffix: string): string[] => {
	const files = fs.readdirSync(dir, {
		withFileTypes: true,
	});

	let commandFiles: string[] = [];

	files.map((file) => {
		if (file.isDirectory()) {
			commandFiles = [...commandFiles, ...getFiles(`${dir}/${file.name}`, suffix)];
		} else if (file.name.endsWith(suffix)) {
			commandFiles.push(`${dir}/${file.name}`);
		}
	});

	return commandFiles;
};

export default getFiles;

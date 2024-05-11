import * as tsConfigPaths from "tsconfig-paths";
import path from "path";

export const configCustomAlias = () => {
	const baseUrl = path.join(__dirname, "../../"); // Adjust the path as needed
	const tsConfigFile = path.resolve(baseUrl, "tsconfig.json");

	tsConfigPaths.register({
		baseUrl,
		paths: require(tsConfigFile).compilerOptions.paths,
	});
};

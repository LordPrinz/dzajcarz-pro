import { getCoFeatures } from "@/db/coFeature";
import { appendElement } from "./list";

export const syncCoRedis = async () => {
	const coFeatures = await getCoFeatures();

	for (const coFeature of coFeatures) {
		await appendElement("coDisabledFeature", coFeature.id);
	}
};

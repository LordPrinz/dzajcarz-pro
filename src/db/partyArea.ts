import PartyAreaModel, { PartyAreaData } from "@/models/partyAreaModel";

export const createPartyArea = async ({ id, ...data }: PartyAreaData) =>
	await PartyAreaModel.create({
		_id: id,
		...data,
	});

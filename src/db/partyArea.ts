import PartyAreaModel, { type PartyAreaData } from "@/models/partyAreaModel";
import { type FilterQuery } from "mongoose";

export const createPartyArea = async ({ id, ...data }: PartyAreaData) =>
	await PartyAreaModel.create({
		_id: id,
		...data,
	});

export const getPartyArea = async (id: string) =>
	await PartyAreaModel.findById(id);

export const getPartyAreas = async (filter?: FilterQuery<PartyAreaData>) =>
	await PartyAreaModel.find(filter);

export const deletePartyArea = async (id: string) =>
	await PartyAreaModel.findByIdAndDelete(id);

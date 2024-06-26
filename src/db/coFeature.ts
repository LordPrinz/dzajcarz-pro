import CoModel, { CoTypeData } from "@/models/coMode";

export const disableCoFeature = async ({ id }: CoTypeData) =>
	await CoModel.create({
		_id: id,
	});

export const enableCoFeature = async (id: string) =>
	await CoModel.findByIdAndDelete(id);

export const getCoFeature = async (id: string) => await CoModel.findById(id);

export const getCoFeatures = async () => await CoModel.find();

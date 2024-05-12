import WelcomeChannelModel, {
	type WelcomeChannelData,
} from "@/models/welcomeChannelModel";

export const getOneByIDWelcomeChannel = async (id: string) =>
	await WelcomeChannelModel.findById(id);

export const updateWelcomeChannel = async ({
	id,
	...data
}: WelcomeChannelData) => {
	return await WelcomeChannelModel.findOneAndUpdate(
		{
			_id: id,
		},
		data,
		{
			upsert: true,
			new: true,
		}
	);
};

export const deleteWelcomeChannel = async (id: string) =>
	await WelcomeChannelModel.findByIdAndDelete(id);

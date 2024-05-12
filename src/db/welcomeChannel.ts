import WelcomeChannelModel, {
	type WelcomeChannel,
} from "@/models/welcomeChannelModel";

export const updateWelcomeChannel = async (data: WelcomeChannel) => {
	const response = await WelcomeChannelModel.findOneAndUpdate(
		{
			id: data.id,
		},
		data,
		{
			upsert: true,
		}
	);

	return response;
};

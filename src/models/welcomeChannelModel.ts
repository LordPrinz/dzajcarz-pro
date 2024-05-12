import mongoose, { Schema } from "mongoose";

type WelcomeChannel = {
	_id: string;
	channelId: string;
	content: string;
};

export type WelcomeChannelData = Omit<WelcomeChannel, "_id"> & { id: string };

const welcomeChannelSchema = new Schema<WelcomeChannel>(
	{
		_id: {
			type: String,
			required: true,
		},
		channelId: {
			type: String,
			required: true,
		},
		content: {
			type: String,
			required: true,
		},
	},
	{
		versionKey: false,
		_id: false,
	}
);

welcomeChannelSchema.set("toJSON", {
	transform: (_, ret) => {
		ret.id = ret._id;
		delete ret._id;
	},
});

welcomeChannelSchema.set("toObject", {
	transform: (_, ret) => {
		ret.id = ret._id;
		delete ret._id;
	},
});

let WelcomeChannelModel: mongoose.Model<WelcomeChannel>;

try {
	WelcomeChannelModel = mongoose.model("welcomeChannels");
} catch {
	WelcomeChannelModel = mongoose.model("welcomeChannels", welcomeChannelSchema);
}

export default WelcomeChannelModel;

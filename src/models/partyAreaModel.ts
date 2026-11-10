import mongoose, { Schema } from "mongoose";

type PartyArea = {
	_id: string; // Category channel ID
	guildId: string;
	splitChannelId: string;
	newChannelName: string;
	commandsChannel?: string;
};

export type PartyAreaData = Omit<PartyArea, "_id"> & { id: string };

const partyAreaSchema = new Schema<PartyArea>(
	{
		_id: {
			type: String,
			required: true,
		},
		guildId: {
			type: String,
			required: true,
		},
		splitChannelId: {
			type: String,
			required: true,
		},
		newChannelName: {
			type: String,
			required: true,
		},
		commandsChannel: {
			type: String,
			required: false,
		},
	},
	{
		versionKey: false,
		_id: false,
	}
);

partyAreaSchema.set("toJSON", {
	transform: (_, ret) => {
		ret.id = ret._id;
		delete ret._id;
	},
});

partyAreaSchema.set("toObject", {
	transform: (_, ret) => {
		ret.id = ret._id;
		delete ret._id;
	},
});

let PartyAreaModel: mongoose.Model<PartyArea>;

try {
	PartyAreaModel = mongoose.model("partyAreas");
} catch {
	PartyAreaModel = mongoose.model("partyAreas", partyAreaSchema);
}

export default PartyAreaModel;

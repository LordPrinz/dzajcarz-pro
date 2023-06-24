import mongoose, { Schema } from "mongoose";

const reqString = {
	type: String,
	required: true,
};

const welcomeSchema = new Schema(
	{
		_id: reqString,
		channelId: reqString,
		text: reqString,
	},
	{
		versionKey: false,
	}
);

const Welcome = mongoose.model("Welcome", welcomeSchema);

export default Welcome;

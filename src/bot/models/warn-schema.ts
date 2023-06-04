import mongoose, { Schema } from "mongoose";

const reqString = {
	type: String,
	required: true,
};

const schema = new Schema(
	{
		userId: reqString,
		guildId: reqString,
		reason: reqString,
		staffId: reqString,
	},
	{ timestamps: true }
);

const name = "warns";

export default mongoose.models[name] || mongoose.model(name, schema);

import mongoose, { Schema } from "mongoose";

const reqString = {
	type: String,
	required: true,
};

const warnSchema = new Schema(
	{
		userId: reqString,
		guildId: reqString,
		reason: reqString,
		staffId: reqString,
	},
	{ timestamps: true }
);

const Warn = mongoose.model("Warn", warnSchema);

export default Warn;

import mongoose, { Schema } from "mongoose";

const reqString = {
	type: String,
	required: true,
};

const punishmentSchema = new Schema(
	{
		userId: reqString,
		guildId: reqString,
		staffId: reqString,
		reason: reqString,
		expires: Date,
		type: {
			type: String,
			required: true,
			enum: ["ban", "mute"],
		},
	},
	{
		timestamps: true,
	}
);

const Punishments = mongoose.model("Punishment", punishmentSchema);

export default Punishments;

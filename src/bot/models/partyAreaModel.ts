import mongoose, { Schema } from "mongoose";

const reqString = {
	type: String,
	required: true,
};

const nonReqString = {
	type: String,
	required: false,
};

const partySchema = new Schema({
	guildId: reqString,
	groupId: reqString,
	splitChannelId: reqString,
	newChannelName: reqString,
	commandsChannel: nonReqString,
});

const Party = mongoose.model("Party", partySchema);

export default Party;

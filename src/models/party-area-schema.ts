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

const name = "partyArea";

export default mongoose.models[name] || mongoose.model(name, partySchema, name);

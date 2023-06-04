import mongoose, { Schema } from "mongoose";

const AuthorSchema = new Schema({
	_id: { type: String, required: true },
	avatar: { type: String, required: true },
	tag: { type: String, required: true },
});

const AttachmentSchema = new Schema({
	_id: { type: String, required: true },
	size: { type: Number, required: true },
	name: { type: String, required: true },
	url: { type: String, required: true },
	proxyURL: { type: String, required: true },
	height: { type: Number, required: false },
	width: { type: Number, required: false },
	contentType: { type: String, required: true },
});

const DNSchema = new Schema({
	_id: { type: String, required: true },
	content: { type: String, required: false },
	attachments: [{ type: AttachmentSchema, required: false }],
	timestamp: { type: Number, required: true },
	author: { type: AuthorSchema, required: true },
	chat: { type: String, required: true },
});

const name = "DMSchema";

export default mongoose.models[name] || mongoose.model(name, DNSchema, name);

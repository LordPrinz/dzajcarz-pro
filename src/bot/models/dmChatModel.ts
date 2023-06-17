import mongoose, { Schema } from "mongoose";
import UserModel from "./userModel";

const AttachmentSchema = new Schema({
	id: { type: String, required: true },
	size: { type: Number, required: true },
	name: { type: String, required: true },
	url: { type: String, required: true },
	proxyURL: { type: String, required: true },
	height: { type: Number, required: false },
	width: { type: Number, required: false },
	contentType: { type: String, required: true },
});

const DMSchema = new Schema(
	{
		_id: { type: String, required: true },
		content: { type: String, required: false },
		attachments: [{ type: AttachmentSchema, required: false }],
		timestamp: { type: Number, required: true },
		author: { type: String, required: true, ref: "User" },
		chat: { type: String, required: true },
	},
	{
		versionKey: false,
	}
);

DMSchema.set("toJSON", {
	transform: function (doc, ret) {
		ret.id = ret._id;
		delete ret._id;
		delete ret.__v;
	},
});

AttachmentSchema.set("toJSON", {
	transform: function (doc, ret) {
		ret.id = ret._id;
		delete ret._id;
		delete ret.__v;
	},
});

DMSchema.pre(/^find/, function (next) {
	this.populate({
		path: "user",
		select: "-__v",
	});

	next();
});

DMSchema.set("toObject", { virtuals: true });

const DmChat = mongoose.model("DmChat", DMSchema);

export default DmChat;

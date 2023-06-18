import mongoose, { Schema } from "mongoose";
import UserModel from "./userModel";

const DMChatSchema = new Schema(
	{
		_id: { type: String, required: true, ref: "User" },
	},
	{
		versionKey: false,
	}
);

DMChatSchema.set("toJSON", {
	transform: function (doc, ret) {
		ret.id = ret._id;
		delete ret._id;
		delete ret.__v;
	},
});

DMChatSchema.pre(/^find/, function (next) {
	this.populate({
		path: "_id",
		select: "-__v",
	});

	next();
});

DMChatSchema.set("toObject", { virtuals: true });

const DMChat = mongoose.model("dmchat", DMChatSchema);

export default DMChat;

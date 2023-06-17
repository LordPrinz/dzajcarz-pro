import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
	{
		_id: {
			type: String,
			required: true,
		},
		avatar: {
			type: String,
			required: true,
		},
		tag: {
			type: String,
			required: true,
		},
		userName: {
			type: String,
			required: true,
		},
	},
	{
		versionKey: false,
		toObject: {
			transform: function (doc, ret) {
				ret.id = ret._id;
				delete ret._id;
				delete ret.__v;
			},
		},
		toJSON: {
			transform: function (doc, ret) {
				ret.id = ret._id;
				delete ret._id;
				delete ret.__v;
			},
		},
	}
);

const User = mongoose.model("User", userSchema);

export default User;

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
	},
	{
		versionKey: false,
	}
);

const User = mongoose.model("ErrorStack", userSchema);

export default User;

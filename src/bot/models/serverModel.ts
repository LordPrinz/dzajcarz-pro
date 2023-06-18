import mongoose, { Schema } from "mongoose";

const ServerSchema = new Schema(
	{
		_id: { type: String, required: true },
		channels: [
			{
				type: String,
				required: true,
			},
		],
		users: [{ type: String, required: true, ref: "User" }],
		name: { type: String, required: true },
	},
	{
		versionKey: false,
	}
);

ServerSchema.set("toJSON", {
	transform: function (doc, ret) {
		ret.id = ret._id;
		delete ret._id;
		delete ret.__v;
	},
});

ServerSchema.pre(/^find/, function (next) {
	this.populate({
		path: "users",
		select: "-__v",
	});

	next();
});

ServerSchema.set("toObject", { virtuals: true });

const Server = mongoose.model("server", ServerSchema);

export default Server;

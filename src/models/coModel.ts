import mongoose, { Schema } from "mongoose";

type CoType = {
	_id: string; // Guild ID
};

export type CoTypeData = Omit<CoType, "_id"> & { id: string };

const coSchema = new Schema<CoType>(
	{
		_id: {
			type: String,
			required: true,
		},
	},
	{
		versionKey: false,
		_id: false,
	}
);

coSchema.set("toJSON", {
	transform: (_, ret) => {
		ret.id = ret._id;
		delete ret._id;
	},
});

coSchema.set("toObject", {
	transform: (_, ret) => {
		ret.id = ret._id;
		delete ret._id;
	},
});

let CoModel: mongoose.Model<CoType>;

try {
	CoModel = mongoose.model("coModel");
} catch {
	CoModel = mongoose.model("coModel", coSchema);
}

export default CoModel;

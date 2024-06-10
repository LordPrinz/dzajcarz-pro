import mongoose from "mongoose";

export const configMongoDB = () => {
	const DB = process.env.MONGO_URI;

	if (!DB) {
		throw new Error("MongoDB URI is missing");
	}

	mongoose.connect(DB).then(() => {
		console.log("DB connected successfully!");
	});
};

import UserModel from "../../bot/models/userModel";
import factory from "./handleFactory";

export default {
	getAllUsers: factory.getAll(UserModel),
	getUser: factory.getOne(UserModel),
};

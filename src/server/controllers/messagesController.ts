import MessageModel from "../../bot/models/messageModel";
import factory from "./handleFactory";

export default {
	getAllDMMessages: factory.getAll(MessageModel),
	getDMMessages: factory.getAll(MessageModel),
};

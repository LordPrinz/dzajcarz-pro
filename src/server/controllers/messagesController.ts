import DMChatModel from "../../bot/models/messageModel";
import factory from "./handleFactory";

export default {
	getAllMessages: factory.getAll(DMChatModel),
	getMessage: factory.getOne(DMChatModel),
};

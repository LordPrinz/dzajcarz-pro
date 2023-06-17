import DMChatModel from "../../bot/models/chatModel";
import factory from "./handleFactory";

export default {
	getAllMessages: factory.getAll(DMChatModel),
	getMessage: factory.getOne(DMChatModel),
};

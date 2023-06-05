import dmChatSchema from "../../bot/models/dm-chat-schema";
import factory from "./handleFactory";

export default {
	getAllMessages: factory.getAll(dmChatSchema),
	getMessage: factory.getOne(dmChatSchema),
};

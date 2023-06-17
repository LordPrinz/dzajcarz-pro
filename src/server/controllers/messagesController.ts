import dmChatSchema from "../../bot/models/dmChatModel";
import factory from "./handleFactory";

export default {
	getAllMessages: factory.getAll(dmChatSchema),
	getMessage: factory.getOne(dmChatSchema),
};

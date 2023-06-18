import ServerModel from "../../bot/models/serverModel";
import handleFactory from "./handleFactory";

export default {
	getAllServers: handleFactory.getAll(ServerModel),
	getServer: handleFactory.getOne(ServerModel),
};

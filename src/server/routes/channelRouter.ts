import express from "express";
import channelController from "../controllers/channelController";

const router = express.Router();

router.route("/:id").get(channelController.getAllChannels); // :id stands for server id

router.route("/:serverId/:channelId").get(channelController.getChannel);

export default router;

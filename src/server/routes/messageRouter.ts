import express from "express";
import msgController from "../controllers/messagesController";

const router = express.Router();

router.route("/me").get(msgController.getAllDMMessages);
router.route("/me/:chat").get(msgController.getDMMessages);

// TODO server message router

router.route("/:serverId/:channelId").get(msgController.getAllMessages);

export default router;

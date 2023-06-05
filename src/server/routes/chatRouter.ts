import express from "express";

import chatController from "../controllers/chatController";

const router = express.Router();

router
	.route("/:id")
	.get(chatController.getChat)
	.post(chatController.sendMessage);

export default router;

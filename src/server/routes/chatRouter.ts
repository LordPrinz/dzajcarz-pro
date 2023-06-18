import express from "express";

const router = express.Router();

router.route("/me/:id");

router.route("/:serverId/:id");

// router
// 	.route("/me/:id")
// 	.get(chatController.getChat)
// 	.post(chatController.sendMessage);

// router.route(":serverId/:id").get();

export default router;

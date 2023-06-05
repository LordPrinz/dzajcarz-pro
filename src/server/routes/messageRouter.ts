import express from "express";
import msgController from "../controllers/messagesController";

const router = express.Router();

router.route("/").get(msgController.getAllMessages);

router.route("/:id").get(msgController.getMessage);

export default router;

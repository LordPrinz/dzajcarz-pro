import express from "express";
import msgController from "../controllers/messagesController";

const router = express.Router();

router.route("/").get(msgController.getAllMessages);

export default router;

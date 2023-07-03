import express from "express";
import emojiController from "../controllers/emojiController";

const router = express.Router();

router.route("/").get(emojiController.getAllEmojis);
router.route("/:id").get(emojiController.getEmoji);

export default router;

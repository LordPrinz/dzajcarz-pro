import { Router } from "express";
import CustomRequest from "../../types/customRequest";

const router = Router();

router.get("/", (req: CustomRequest, res) => {
	const io = req.io;

	if (!io) {
		return;
	}

	io.emit("message", "Hello Socket.IO!");
	res.json({ message: "Hello World!" });
});

export default router;

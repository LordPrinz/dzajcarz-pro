import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
	const io = req.io;

	if (!io) {
		return;
	}

	io.emit("message", "Hello Socket.IO!");
	res.json({ message: "Hello World!" });
});

export default router;

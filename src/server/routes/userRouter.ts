import express from "express";
import usersController from "../controllers/usersController";
const router = express.Router();

router.route("/").get(usersController.getAllUsers);
router.route("/:id").get(usersController.getUser);

export default router;

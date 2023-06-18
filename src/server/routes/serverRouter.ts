import express from "express";
import serverController from "../controllers/serverController";
const router = express.Router();

router.route("/").get(serverController.getAllServers);

router.route("/me").get(serverController.getDMServers);
router.route("/:id").get(serverController.getServer);

export default router;

import { Request } from "express";
import { Server } from "socket.io";

interface CustomRequest extends Request {
	io?: Server;
}

export default CustomRequest;

export type errorType = {
	status: string;
	message: string;
	stack: string;
	path: string;
	value: string;
	errmsg: string;
	errors: errorType[];
	isOperational: boolean;
	statusCode: number;
	name: string;
	code: number;
};

declare global {
	namespace NodeJS {
		interface ProcessEnv {
			NODE_ENV: "development" | "production";
			REDIS_URL: string;
			POSTGRE_URL: string;
			BOT_PRODUCTION_TOKEN:string;
			BOT_DEVELOPMENT_TOKEN:string;
		}
	}
}

export {};
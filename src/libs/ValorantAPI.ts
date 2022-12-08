import { ValorantApi } from "wrapper-valorant-api";

const APIKEY = process.env.VALORANT_API_KEY || "";

const Api = new ValorantApi(APIKEY);

export default Api;

import { SQL } from "bun";

export function createDb(url: string): SQL {
  return new SQL(url);
}

export type Db = SQL;
export * from "./dzajco.ts";
export * from "./guild-data.ts";
export * from "./guild-settings.ts";
export * from "./moderation.ts";
export * from "./module-toggles.ts";
export * from "./party.ts";
export * from "./scheduled-messages.ts";
export * from "./scheduled-songs.ts";
export * from "./types.ts";
export * from "./welcome.ts";

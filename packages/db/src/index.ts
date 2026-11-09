import { SQL } from "bun";

export function createDb(url: string): SQL {
  return new SQL(url);
}

export type Db = SQL;
export * from "./guild-settings.ts";
export * from "./module-toggles.ts";
export * from "./party.ts";
export * from "./scheduled-messages.ts";
export * from "./scheduled-songs.ts";
export * from "./types.ts";
export * from "./welcome.ts";

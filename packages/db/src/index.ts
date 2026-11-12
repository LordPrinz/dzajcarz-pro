import { SQL } from "bun";

export function createDb(url: string): SQL {
  return new SQL(url);
}

export * from "./archive-reader.ts";
export * from "./archive-settings.ts";
export * from "./dzajco.ts";
export * from "./guild-data.ts";
export * from "./guild-settings.ts";
export * from "./message-archive.ts";
export * from "./moderation.ts";
export * from "./module-toggles.ts";
export * from "./party.ts";
export * from "./scheduled-messages.ts";
export * from "./scheduled-songs.ts";
export * from "./types.ts";
export * from "./web-audit.ts";
export * from "./web-uploads.ts";
export * from "./welcome.ts";

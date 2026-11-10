import { CommandObject } from "wokcommands";

export type CommandCategories =
	| "configuration"
	| "fun"
	| "test"
	| "party"
	| "moderation";

export type DzajCommand = CommandObject & { name: string };

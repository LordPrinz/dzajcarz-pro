import { CommandObject } from "wokcommands";

export type CommandCategories = "configuration" | "fun" | "test";

export type DzajCommand = CommandObject & { name: string };

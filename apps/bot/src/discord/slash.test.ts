import { describe, expect, test } from "bun:test";
import { defineCommand, defineSubcommand } from "@dzajcarz/core";
import {
  ApplicationCommandOptionType,
  InteractionContextType,
  PermissionFlagsBits,
} from "discord.js";
import { toSlashCommand } from "./slash.ts";

const noop = async () => {};

describe("toSlashCommand", () => {
  test("maps options in declaration order, with choices and limits", () => {
    const command = defineCommand({
      name: "volume",
      description: "Volume",
      options: {
        level: {
          type: "integer",
          description: "Level",
          required: true,
          minValue: 0,
          maxValue: 150,
        },
        mode: {
          type: "string",
          description: "Mode",
          choices: [{ name: "Loud", value: "loud" }],
        },
        who: { type: "user", description: "Who" },
      },
      run: noop,
    });
    const body = toSlashCommand(command);
    expect(body.options).toEqual([
      {
        name: "level",
        description: "Level",
        required: true,
        type: ApplicationCommandOptionType.Integer,
        min_value: 0,
        max_value: 150,
        choices: undefined,
      },
      {
        name: "mode",
        description: "Mode",
        required: false,
        type: ApplicationCommandOptionType.String,
        choices: [{ name: "Loud", value: "loud" }],
      },
      { name: "who", description: "Who", required: false, type: ApplicationCommandOptionType.User },
    ]);
    expect(body.contexts).toEqual([InteractionContextType.Guild, InteractionContextType.BotDM]);
    expect(body.default_member_permissions).toBeUndefined();
  });

  test("a command with permissions is guild-only and hidden from members without them", () => {
    const body = toSlashCommand(
      defineCommand({
        name: "ban",
        description: "Ban",
        permissions: PermissionFlagsBits.BanMembers,
        run: noop,
      }),
    );
    expect(body.contexts).toEqual([InteractionContextType.Guild]);
    expect(body.default_member_permissions).toBe(PermissionFlagsBits.BanMembers.toString());
  });
});

describe("toSlashCommand with subcommands", () => {
  test("maps each subcommand to a SUB_COMMAND option holding its own options", () => {
    const body = toSlashCommand(
      defineCommand({
        name: "prefix",
        description: "Prefix",
        permissions: PermissionFlagsBits.ManageGuild,
        subcommands: {
          set: defineSubcommand({
            description: "Set",
            permissions: PermissionFlagsBits.Administrator,
            options: { value: { type: "string", description: "Value", required: true } },
            run: noop,
          }),
          show: defineSubcommand({ description: "Show", run: noop }),
        },
      }),
    );
    expect(body.options).toEqual([
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "set",
        description: "Set",
        options: [
          {
            name: "value",
            description: "Value",
            required: true,
            type: ApplicationCommandOptionType.String,
            choices: undefined,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "show",
        description: "Show",
        options: [],
      },
    ]);
    // Only the command-level permission reaches Discord; subcommand permissions are checked at runtime.
    expect(body.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });
});

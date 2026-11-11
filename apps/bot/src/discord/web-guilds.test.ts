import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import { createGuildList } from "./web-guilds.ts";

function guild(id: string, name: string, icon: string | null, memberCount: number) {
  return [id, { id, name, memberCount, iconURL: () => icon }] as const;
}

test("lists the cached guilds sorted by name", () => {
  const client = {
    guilds: {
      cache: new Map([
        guild("200000000000000002", "Żaba", null, 7),
        guild("100000000000000001", "Alfa", "https://cdn.example/a.png", 3),
      ]),
    },
  } as unknown as Client;
  expect(createGuildList(client)()).toEqual([
    {
      id: "100000000000000001",
      name: "Alfa",
      iconUrl: "https://cdn.example/a.png",
      memberCount: 3,
    },
    { id: "200000000000000002", name: "Żaba", iconUrl: null, memberCount: 7 },
  ]);
});

test("is empty when the bot is in no guild", () => {
  const client = { guilds: { cache: new Map() } } as unknown as Client;
  expect(createGuildList(client)()).toEqual([]);
});

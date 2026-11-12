import { expect, test } from "bun:test";
import { createArchiveControl } from "./archive-control.ts";

const GUILD = "100000000000000001";
const COMMAND = { deadline: Date.now() + 3_000 };

test("a change is stored before the cached copy is refreshed", async () => {
  const steps: string[] = [];
  const control = createArchiveControl({
    settings: {
      async setGuild(settings) {
        steps.push("store guild");
        return { ...settings, excludedChannelIds: [...settings.excludedChannelIds].sort() };
      },
      async setDm(enabled) {
        steps.push("store dm");
        return enabled;
      },
    },
    policy: {
      async forgetGuild(guildId) {
        steps.push(`forget ${guildId}`);
      },
      async forgetDm() {
        steps.push("forget dm");
      },
    },
    backfill: async () => ({ status: "not_archived" }),
  });
  expect(
    await control.setGuild(
      { guildId: GUILD, enabled: true, excludedChannelIds: ["2", "1"] },
      COMMAND,
    ),
  ).toEqual({ guildId: GUILD, enabled: true, excludedChannelIds: ["1", "2"] });
  expect(await control.setDm({ enabled: true }, COMMAND)).toEqual({ enabled: true });
  expect(steps).toEqual(["store guild", `forget ${GUILD}`, "store dm", "forget dm"]);
});

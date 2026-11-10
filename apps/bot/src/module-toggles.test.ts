import { describe, expect, test } from "bun:test";
import type { ModuleToggleRepository } from "@dzajcarz/db";
import { createModuleToggles } from "./module-toggles.ts";

function setup(enableChanges = true) {
  const steps: string[] = [];
  const repository = {
    listDisabled: async () => [],
    disable: async (guildId: string, module: string, channelId: string | null) =>
      void steps.push(`disable ${guildId} ${module} ${channelId}`),
    enable: async (guildId: string, module: string, channelId: string | null) => {
      steps.push(`enable ${guildId} ${module} ${channelId}`);
      return enableChanges;
    },
  } as unknown as ModuleToggleRepository;
  const gate = { forget: async (guildId: string) => void steps.push(`forget ${guildId}`) };
  return { steps, toggles: createModuleToggles(repository, gate, () => ["fun", "music"]) };
}

describe("module toggles", () => {
  test("disabling writes first, then drops the cached set so the next message sees it", async () => {
    const { steps, toggles } = setup();
    await toggles.disable("g", "fun", "c");
    expect(steps).toEqual(["disable g fun c", "forget g"]);
  });

  test("enabling also drops the cache and reports whether anything changed", async () => {
    const { steps, toggles } = setup(false);
    expect(await toggles.enable("g", "fun", null)).toBe(false);
    expect(steps).toEqual(["enable g fun null", "forget g"]);
  });

  test("lists the module names it was given", () => {
    expect(setup().toggles.moduleNames()).toEqual(["fun", "music"]);
  });

  test("a failed write leaves the cache alone", async () => {
    const steps: string[] = [];
    const broken = createModuleToggles(
      {
        disable: async () => {
          throw new Error("db down");
        },
      } as unknown as ModuleToggleRepository,
      { forget: async (guildId: string) => void steps.push(`forget ${guildId}`) },
      () => [],
    );
    await expect(broken.disable("g", "fun", null)).rejects.toThrow("db down");
    expect(steps).toEqual([]);
  });
});

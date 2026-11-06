import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { type Activity, type Clock, createStatusModule } from "./index.ts";

const ACTIVITIES: Activity[] = [
  { type: "playing", text: "a" },
  { type: "watching", text: "b" },
  { type: "custom", text: "c" },
];

function setup(options: { activities?: Activity[]; failOn?: number } = {}) {
  const shown: Activity[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextHandle = 1;
  let calls = 0;
  const clock: Clock = {
    setInterval: (fn, ms) => {
      timers.set(nextHandle, { fn, ms });
      return nextHandle++;
    },
    clearInterval: (handle) => void timers.delete(handle as number),
  };
  const module = createStatusModule({
    presence: {
      setActivity: (activity) => {
        calls++;
        if (calls === options.failOn) throw new Error("gateway not ready");
        shown.push(activity);
      },
    },
    clock,
    logger: silentLogger,
    activities: options.activities ?? ACTIVITIES,
    intervalMs: 5000,
  });
  const ready = () => module.events?.[0]?.run({} as never);
  const tick = () => {
    for (const timer of timers.values()) timer.fn();
  };
  return { module, shown, timers, ready, tick };
}

describe("status module", () => {
  test("sets the first activity on ready and schedules the rotation", async () => {
    const { shown, timers, ready } = setup();
    await ready();
    expect(shown).toEqual([ACTIVITIES[0] as Activity]);
    expect([...timers.values()].map((t) => t.ms)).toEqual([5000]);
  });

  test("rotates in order and wraps around", async () => {
    const { shown, ready, tick } = setup();
    await ready();
    for (let i = 0; i < 4; i++) tick();
    expect(shown.map((a) => a.text)).toEqual(["a", "b", "c", "a", "b"]);
  });

  test("a second ready does not start a second interval", async () => {
    const { shown, timers, ready } = setup();
    await ready();
    await ready();
    expect(timers.size).toBe(1);
    expect(shown).toHaveLength(1);
  });

  test("dispose clears the interval", async () => {
    const { module, timers, ready } = setup();
    await ready();
    await module.dispose?.();
    expect(timers.size).toBe(0);
  });

  test("dispose before ready is a no-op", async () => {
    const { module, timers } = setup();
    await module.dispose?.();
    expect(timers.size).toBe(0);
  });

  test("a failing setActivity is logged and rotation continues", async () => {
    const { shown, ready, tick } = setup({ failOn: 1 });
    await ready();
    tick();
    expect(shown.map((a) => a.text)).toEqual(["b"]);
  });

  test("a single activity keeps repeating", async () => {
    const { shown, ready, tick } = setup({ activities: [ACTIVITIES[0] as Activity] });
    await ready();
    tick();
    expect(shown).toHaveLength(2);
  });

  test("rejects an empty activity list", () => {
    expect(() => setup({ activities: [] })).toThrow();
  });
});

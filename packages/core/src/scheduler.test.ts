import { describe, expect, test } from "bun:test";
import { createScheduler } from "./scheduler.ts";
import { createFakeScheduler } from "./testing/context.ts";

describe("createScheduler", () => {
  test("runs the task once after the delay", async () => {
    const ran: number[] = [];
    createScheduler().after(5, () => void ran.push(1));
    expect(ran).toEqual([]);
    await Bun.sleep(30);
    expect(ran).toEqual([1]);
  });

  test("the returned function cancels it", async () => {
    const ran: number[] = [];
    const cancel = createScheduler().after(5, () => void ran.push(1));
    cancel();
    await Bun.sleep(30);
    expect(ran).toEqual([]);
  });
});

describe("createFakeScheduler", () => {
  test("runs tasks in due order as time advances, and not before", () => {
    const scheduler = createFakeScheduler();
    const ran: string[] = [];
    scheduler.after(20, () => void ran.push("b"));
    scheduler.after(10, () => void ran.push("a"));
    scheduler.advance(9);
    expect(ran).toEqual([]);
    scheduler.advance(11);
    expect(ran).toEqual(["a", "b"]);
    expect(scheduler.pending).toBe(0);
  });

  test("a task scheduled by a task is measured from the moment it ran", () => {
    const scheduler = createFakeScheduler();
    const ran: string[] = [];
    scheduler.after(10, () => scheduler.after(10, () => void ran.push("inner")));
    scheduler.advance(15);
    expect(ran).toEqual([]);
    scheduler.advance(5);
    expect(ran).toEqual(["inner"]);
  });

  test("a cancelled task never runs", () => {
    const scheduler = createFakeScheduler();
    const ran: string[] = [];
    scheduler.after(10, () => void ran.push("x"))();
    scheduler.advance(100);
    expect(ran).toEqual([]);
  });
});

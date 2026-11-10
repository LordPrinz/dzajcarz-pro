import { describe, expect, test } from "bun:test";
import {
  BOT_BRANCH_PATTERN,
  BRANCH_PATTERN,
  GENERATED_HEADER,
  HEADER_PATTERN,
  ticketFromBranch,
} from "./conventions.ts";

describe("git conventions", () => {
  test.each([
    "[DZAJ-44] chore: Set user permissions",
    "[DZAJ-1] feat(music): Add queue command",
    "[DZAJ-120] fix(core)!: Reject duplicate command names",
  ])("accepts header %p", (header) => {
    expect(HEADER_PATTERN.test(header)).toBe(true);
  });

  test.each([
    "chore: Set user permissions",
    "[DZAJ-44] chores: Set user permissions",
    "[DZAJ-44] chore:Set user permissions",
    "[DZAJ-44]chore: Set user permissions",
    "[DZAJ-x] chore: Set user permissions",
    "[DZAJ-44] chore: ok",
  ])("rejects header %p", (header) => {
    expect(HEADER_PATTERN.test(header)).toBe(false);
  });

  test("lets git-generated headers through", () => {
    expect(GENERATED_HEADER.test("Merge branch 'main' into DZAJ-4-x")).toBe(true);
    expect(GENERATED_HEADER.test('Revert "[DZAJ-4] feat: X"')).toBe(true);
  });

  test("validates branch names", () => {
    expect(BRANCH_PATTERN.test("DZAJ-44-set-user-permissions")).toBe(true);
    expect(BRANCH_PATTERN.test("feature/login")).toBe(false);
    expect(BRANCH_PATTERN.test("DZAJ-44-Set-User")).toBe(false);
  });

  test("recognises Dependabot branches", () => {
    expect(BOT_BRANCH_PATTERN.test("dependabot/github_actions/actions/checkout-7")).toBe(true);
    expect(BOT_BRANCH_PATTERN.test("dependabot/bun/minor-and-patch-1a2b3c")).toBe(true);
    expect(BOT_BRANCH_PATTERN.test("dependabot-checkout")).toBe(false);
    expect(HEADER_PATTERN.test("[DZAJ-3] build(deps): Bump actions/checkout from 5 to 7")).toBe(
      true,
    );
  });

  test("extracts the ticket from a branch", () => {
    expect(ticketFromBranch("DZAJ-44-set-user-permissions")).toBe("DZAJ-44");
    expect(ticketFromBranch("main")).toBeUndefined();
    expect(ticketFromBranch("main")).toBeUndefined();
  });
});

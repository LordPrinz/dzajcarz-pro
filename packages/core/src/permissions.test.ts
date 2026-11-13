import { expect, test } from "bun:test";
import { ADMINISTRATOR, hasPermissions, isAdministrator, MANAGE_GUILD } from "./permissions.ts";

const MANAGE_CHANNELS = 1n << 4n;

test("a member needs every required bit", () => {
  expect(hasPermissions(MANAGE_GUILD | MANAGE_CHANNELS, MANAGE_GUILD)).toBe(true);
  expect(hasPermissions(MANAGE_CHANNELS, MANAGE_GUILD | MANAGE_CHANNELS)).toBe(false);
  expect(hasPermissions(null, MANAGE_GUILD)).toBe(false);
});

test("Administrator holds every permission", () => {
  expect(hasPermissions(ADMINISTRATOR, MANAGE_GUILD | MANAGE_CHANNELS)).toBe(true);
  expect(isAdministrator(ADMINISTRATOR | MANAGE_GUILD)).toBe(true);
  expect(isAdministrator(MANAGE_GUILD)).toBe(false);
  expect(isAdministrator(undefined)).toBe(false);
});

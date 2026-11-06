import { describe, expect, test } from "bun:test";
import { MAX_MESSAGE_LENGTH, renderWelcome, type WelcomeValues } from "./template.ts";

const values: WelcomeValues = {
  userId: "42",
  username: "Ola",
  serverName: "Dżajsy",
  memberCount: 7,
};

describe("renderWelcome", () => {
  test("fills every placeholder, repeated ones too", () => {
    expect(renderWelcome("{user} to {username}, {server} ma {memberCount}. {user}!", values)).toBe(
      "<@42> to Ola, Dżajsy ma 7. <@42>!",
    );
  });

  test("leaves unknown placeholders and stray braces as text", () => {
    expect(renderWelcome("{nope} {User} { user } {", values)).toBe("{nope} {User} { user } {");
  });

  test("placeholders named like Object.prototype members stay as text", () => {
    expect(renderWelcome("{constructor} {toString}", values)).toBe("{constructor} {toString}");
  });

  test("does not substitute inside substituted text", () => {
    const tricky = { ...values, username: "{server}", serverName: "{memberCount}" };
    expect(renderWelcome("{username} @ {server}", tricky)).toBe("{server} @ {memberCount}");
  });

  test("escapes markdown in the member and server names, not in the template", () => {
    const loud = { ...values, username: "**Ola**_[x](y)", serverName: "~~Dżajsy~~ @everyone" };
    expect(renderWelcome("**{username}** @ {server}", loud)).toBe(
      "**\\*\\*Ola\\*\\*\\_\\[x\\]\\(y\\)** @ \\~\\~Dżajsy\\~\\~ \\@everyone",
    );
  });

  test("cuts by code points, never in the middle of an emoji", () => {
    const out = renderWelcome("😀".repeat(MAX_MESSAGE_LENGTH + 5), values);
    expect([...out]).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(out.endsWith("😀")).toBe(true);
    expect(out.isWellFormed()).toBe(true);
  });

  test("caps the output at 2000 characters", () => {
    const out = renderWelcome(`{username}${"x".repeat(MAX_MESSAGE_LENGTH)}`, values);
    expect(out).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(out.startsWith("Olaxx")).toBe(true);
  });

  test("a template without placeholders is returned unchanged", () => {
    expect(renderWelcome("Witaj!", values)).toBe("Witaj!");
  });
});

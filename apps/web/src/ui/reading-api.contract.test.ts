// The page declares the protocol's shapes itself, since it does not bundle zod. This file fails to type-check
// when the two drift apart; the test only keeps bun from calling it empty.
import { expect, test } from "bun:test";
import type * as Protocol from "@dzajcarz/web-protocol";
import type * as Page from "./reading-api.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <A, B>(value: Same<A, B>) => value;

test("the page's message shapes are the protocol's", () => {
  expect(same<Page.PanelMessage, Protocol.PanelMessage>(true)).toBe(true);
  expect(same<Page.PanelAuthor, Protocol.PanelAuthor>(true)).toBe(true);
  expect(same<Page.PanelAttachment, Protocol.PanelAttachment>(true)).toBe(true);
  expect(same<Page.EmbedCard, Protocol.EmbedCard>(true)).toBe(true);
  expect(same<Page.Resolved, Protocol.Resolved>(true)).toBe(true);
  expect(same<Page.DmEntry["recipient"], Protocol.DmChannel["recipient"]>(true)).toBe(true);
});

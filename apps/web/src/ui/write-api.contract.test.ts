// The page declares the writing shapes and limits itself, since it does not bundle zod. This file fails to
// type-check when the shapes drift apart, and the test fails when the limits do.
import { expect, test } from "bun:test";
import * as Protocol from "@dzajcarz/web-protocol";
import * as Page from "./write-api.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <A, B>(value: Same<A, B>) => value;

type ProtocolInfo = Omit<Extract<Protocol.ChannelInfo, { status: "ok" }>, "status">;

test("the page's writing shapes are the protocol's", () => {
  expect(same<Page.ChannelInfo, ProtocolInfo>(true)).toBe(true);
  expect(same<Page.MemberResult, Protocol.MemberResult>(true)).toBe(true);
  expect(
    same<Extract<Page.WriteError, Protocol.WriteRejection>, Protocol.WriteRejection>(true),
  ).toBe(true);
});

test("the page's limits are the protocol's", () => {
  expect(Page.MAX_MESSAGE_LENGTH).toBe(Protocol.MAX_MESSAGE_LENGTH);
  expect(Page.MAX_FILES).toBe(Protocol.MAX_FILES);
  expect(Page.MAX_UPLOAD_BYTES).toBe(Protocol.MAX_UPLOAD_BYTES);
  expect(Page.DEFAULT_UPLOAD_LIMIT).toBe(Protocol.DEFAULT_UPLOAD_LIMIT);
  expect(Page.MIN_MEMBER_QUERY_LENGTH).toBe(Protocol.MIN_MEMBER_QUERY_LENGTH);
});

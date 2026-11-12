// The page declares the music shapes and limits itself, since it does not bundle zod. This file fails to
// type-check when the shapes drift apart, and the test fails when the limits do.
import { expect, test } from "bun:test";
import * as Protocol from "@dzajcarz/web-protocol";
import * as Page from "./music-api.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <A, B>(value: Same<A, B>) => value;

type ProtocolSearch = Omit<Extract<Protocol.MusicSearchResult, { status: "ok" }>, "status">;

test("the page's music shapes are the protocol's", () => {
  expect(same<Page.MusicTrackInfo, Protocol.MusicTrackInfo>(true)).toBe(true);
  expect(same<Page.MusicPlayerInfo, Protocol.MusicPlayerInfo>(true)).toBe(true);
  expect(same<Page.MusicSnapshot, Protocol.MusicSnapshot>(true)).toBe(true);
  expect(same<Page.VoiceChannelInfo, Protocol.VoiceChannelInfo>(true)).toBe(true);
  expect(same<Page.MusicSearch, ProtocolSearch>(true)).toBe(true);
  expect(same<Page.MusicControl, Protocol.MusicControl>(true)).toBe(true);
  expect(
    same<Extract<Page.MusicError, Protocol.MusicRejection>, Protocol.MusicRejection>(true),
  ).toBe(true);
});

test("the page's limits and choices are the protocol's", () => {
  expect(Page.MAX_MUSIC_VOLUME).toBe(Protocol.MAX_MUSIC_VOLUME);
  expect(Page.MUSIC_QUEUE_PAGE).toBe(Protocol.MUSIC_QUEUE_PAGE);
  expect(Page.MAX_MUSIC_QUERY_LENGTH).toBe(Protocol.MAX_MUSIC_QUERY_LENGTH);
  expect(Object.keys(Page.LOOP_LABELS)).toEqual([...Protocol.LOOP_MODES]);
  expect(Object.keys(Page.FILTER_LABELS)).toEqual([...Protocol.MUSIC_FILTERS]);
});

import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type { ArchivedMessageInput } from "@dzajcarz/db";
import { createArchiveRecorder } from "./archive-recorder.ts";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const EXCLUDED = "200000000000000009";

function message(overrides: Partial<ArchivedMessageInput> = {}): ArchivedMessageInput {
  return {
    id: "500000000000000001",
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: "3", username: "bot", displayName: null, avatarUrl: null, bot: true },
    content: "hej",
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    editedAt: null,
    ...overrides,
  };
}

/** Archives GUILD except EXCLUDED; DMs only when `dm` is on. */
function setup({
  dm = false,
  failWrites = false,
  failPolicy = false,
  insertGate = Promise.resolve(),
} = {}) {
  const calls: unknown[][] = [];
  const errors: unknown[] = [];
  const fail = () => {
    throw new Error("postgres down");
  };
  const recorder = createArchiveRecorder({
    policy: {
      async archives(guildId, channelIds) {
        if (failPolicy) fail();
        if (guildId === null) return dm;
        return guildId === GUILD && !channelIds.includes(EXCLUDED);
      },
    },
    archive: {
      async insertMissing(messages) {
        calls.push(["insertMissing", messages.map((m) => m.id)]);
        await insertGate;
        calls.push(["inserted"]);
        if (failWrites) fail();
        return messages.length;
      },
      async recordEdit(m) {
        calls.push(["recordEdit", m.id, m.content]);
        if (failWrites) fail();
        return true;
      },
      async markDeleted(ids, at) {
        calls.push(["markDeleted", [...ids], at]);
        if (failWrites) fail();
        return ids.length;
      },
    },
    logger: { ...silentLogger, error: (_message, context) => void errors.push(context) },
  });
  return { recorder, calls, errors };
}

const AT = new Date("2026-11-02T00:00:00.000Z");
const PLACE = { guildId: GUILD, channelId: CHANNEL, parentId: null };

describe("archive recorder", () => {
  /** Where the message lives. */
  const placeOf = (m: ArchivedMessageInput, parentId: string | null = null) => ({
    guildId: m.guildId,
    channelId: m.channelId,
    parentId,
  });
  const create = (
    recorder: ReturnType<typeof setup>["recorder"],
    m: ArchivedMessageInput,
    parentId: string | null = null,
  ) => recorder.created(placeOf(m, parentId), m);
  const ID = "500000000000000001";

  test("stores a new message, bot messages included", async () => {
    const { recorder, calls } = setup();
    await create(recorder, message());
    expect(calls).toEqual([["insertMissing", [ID]], ["inserted"]]);
  });

  test("an edit goes to the version history", async () => {
    const { recorder, calls } = setup();
    await recorder.updated(PLACE, ID, async () => message({ content: "poprawione" }));
    expect(calls).toEqual([["recordEdit", ID, "poprawione"]]);
  });

  test("an edit of a message that is gone is skipped", async () => {
    const { recorder, calls, errors } = setup();
    await recorder.updated(PLACE, ID, async () => null);
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a delete and a bulk delete mark every id", async () => {
    const { recorder, calls } = setup();
    await recorder.deleted(PLACE, ["1"], AT);
    await recorder.deleted(PLACE, ["2", "3"], AT);
    expect(calls).toEqual([
      ["markDeleted", ["1"], AT],
      ["markDeleted", ["2", "3"], AT],
    ]);
  });

  test("a delete or an edit that arrives while the create is still running waits for it", async () => {
    let release = () => {};
    const insertGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { recorder, calls } = setup({ insertGate });
    const created = create(recorder, message());
    const edited = recorder.updated(PLACE, ID, async () => message({ content: "poprawione" }));
    const deleted = recorder.deleted(PLACE, ["1", ID], AT);
    await Bun.sleep(5);
    expect(calls).toEqual([["insertMissing", [ID]]]);
    release();
    await Promise.all([created, edited, deleted]);
    expect(calls).toEqual([
      ["insertMissing", [ID]],
      ["inserted"],
      ["recordEdit", ID, "poprawione"],
      ["markDeleted", ["1", ID], AT],
    ]);
  });

  test("a failed create does not hold up the events after it", async () => {
    const { recorder, calls } = setup({ failWrites: true });
    await Promise.all([create(recorder, message()), recorder.deleted(PLACE, [ID], AT)]);
    expect(calls.at(-1)).toEqual(["markDeleted", [ID], AT]);
  });

  test("a server that is not archived is not touched", async () => {
    const { recorder, calls } = setup();
    const other = "100000000000000002";
    await create(recorder, message({ guildId: other }));
    let loaded = false;
    await recorder.updated({ ...PLACE, guildId: other }, ID, async () => {
      loaded = true;
      return message({ guildId: other });
    });
    expect(loaded).toBe(false);
    await recorder.deleted({ ...PLACE, guildId: other }, ["1"], AT);
    expect(calls).toEqual([]);
  });

  test("an excluded channel and the threads under it are not touched", async () => {
    const { recorder, calls } = setup();
    await create(recorder, message({ channelId: EXCLUDED }));
    await create(recorder, message({ channelId: "200000000000000010" }), EXCLUDED);
    await recorder.deleted({ ...PLACE, channelId: EXCLUDED }, ["1"], AT);
    expect(calls).toEqual([]);
  });

  test("DMs are stored only while the DM switch is on", async () => {
    const off = setup({ dm: false });
    await create(off.recorder, message({ guildId: null }));
    expect(off.calls).toEqual([]);
    const on = setup({ dm: true });
    await create(on.recorder, message({ guildId: null }));
    expect(on.calls).toHaveLength(2);
  });

  test("a failing write is logged and never thrown", async () => {
    const { recorder, errors } = setup({ failWrites: true });
    await create(recorder, message());
    await recorder.updated(PLACE, ID, async () => message());
    await recorder.deleted(PLACE, ["1"], AT);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatchObject({ event: "create", guildId: GUILD, channelId: CHANNEL });
  });

  test("a failing settings lookup is logged and never thrown", async () => {
    const { recorder, calls, errors } = setup({ failPolicy: true });
    await create(recorder, message());
    expect(calls).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

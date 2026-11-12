import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { scrollTarget, VirtualList } from "./VirtualList.tsx";

// happy-dom has no layout: rows are 100 px high and the viewport is 500 px, by stubbing what the list reads.
const ROW = 100;
const VIEWPORT = 500;
let restore: (() => void) | undefined;

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  const client = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const height = this.classList.contains("vlist-row") ? ROW : 0;
    return { height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0 } as DOMRect;
  };
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("vlist") ? VIEWPORT : 0;
    },
  });
  restore = () => {
    proto.getBoundingClientRect = rect;
    if (client) Object.defineProperty(proto, "clientHeight", client);
  };
});

afterAll(async () => {
  restore?.();
  await GlobalRegistrator.unregister();
});

const keys = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `m${String(from + i).padStart(4, "0")}`);

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  const render = (items: string[], focusKey: string | null = null) =>
    act(() => {
      root ??= createRoot(container);
      root.render(
        <VirtualList
          items={items}
          keyOf={(item) => item}
          render={(item) => item}
          focusKey={focusKey}
          label="Lista"
        />,
      );
    });
  const scroller = () => container.querySelector(".vlist") as HTMLElement;
  const scrollTo = (top: number) =>
    act(() => {
      scroller().scrollTop = top;
      scroller().dispatchEvent(new Event("scroll"));
    });
  const rowTop = (key: string) => {
    const row = [...container.querySelectorAll<HTMLElement>(".vlist-row")].find(
      (element) => element.textContent === key,
    );
    return Number(/translateY\((-?[\d.]+)px\)/.exec(row?.style.transform ?? "")?.[1]);
  };
  const unmount = () => act(() => root?.unmount());
  return { render, scroller, scrollTo, rowTop, unmount };
}

describe("VirtualList in a DOM", () => {
  test("follows new rows while it is at the bottom", async () => {
    const list = mount();
    await list.render(keys(0, 20));
    expect(list.scroller().scrollTop).toBe(20 * ROW - VIEWPORT);
    await list.render(keys(0, 25));
    expect(list.scroller().scrollTop).toBe(25 * ROW - VIEWPORT);
    await list.unmount();
  });

  test("keeps what is on screen in place when older rows arrive above", async () => {
    const list = mount();
    await list.render(keys(10, 40));
    await list.scrollTo(800);
    const before = list.rowTop("m0018") - list.scroller().scrollTop;
    await list.render(keys(0, 40));
    // The new rows are off screen and still count with their estimate; the shown row has not moved.
    expect(list.scroller().scrollTop).toBeGreaterThan(800);
    expect(list.rowTop("m0018") - list.scroller().scrollTop).toBe(before);
    await list.unmount();
  });

  test("a scrolled-up list stays put when a new row arrives at the bottom", async () => {
    const list = mount();
    await list.render(keys(0, 30));
    await list.scrollTo(300);
    await list.render(keys(0, 31));
    expect(list.scroller().scrollTop).toBe(300);
    await list.unmount();
  });

  test("a focused row lands a third down the viewport once the rows are measured", async () => {
    const list = mount();
    await list.render(keys(0, 60), "m0030");
    // The rows start with an estimated height and change to 100 px as they render; the focus stays put.
    expect(list.rowTop("m0030") - list.scroller().scrollTop).toBeCloseTo(VIEWPORT / 3, 0);
    expect(list.scroller().querySelectorAll(".vlist-row").length).toBeLessThan(30);
    await list.unmount();
  });
});

describe("scrollTarget", () => {
  const offsets = [0, 100, 200, 300, 400, 500, 600, 700, 800];
  const keysOf = ["a", "b", "c", "d", "e", "f", "g", "h"];

  test("the bottom, the anchor, or nothing", () => {
    expect(
      scrollTarget({ atBottom: true, anchor: null, keys: keysOf, offsets, viewport: 300 }),
    ).toBe(500);
    expect(
      scrollTarget({
        atBottom: false,
        anchor: { key: "d", delta: 20 },
        keys: keysOf,
        offsets,
        viewport: 300,
      }),
    ).toBe(320);
    expect(
      scrollTarget({ atBottom: false, anchor: null, keys: keysOf, offsets, viewport: 300 }),
    ).toBeNull();
    expect(
      scrollTarget({
        atBottom: false,
        anchor: { key: "gone", delta: 0 },
        keys: keysOf,
        offsets,
        viewport: 300,
      }),
    ).toBeNull();
  });

  test("is clamped to what can be scrolled", () => {
    const base = { atBottom: false, keys: keysOf, offsets, viewport: 300 };
    expect(scrollTarget({ ...base, anchor: { key: "a", delta: -100 } })).toBe(0);
    expect(scrollTarget({ ...base, anchor: { key: "h", delta: 0 } })).toBe(500);
  });
});

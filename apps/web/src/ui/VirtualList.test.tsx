import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { offsetsOf, rowAt, VirtualList, visibleRange } from "./VirtualList.tsx";

describe("offsetsOf and rowAt", () => {
  test("offsets are running sums, rowAt finds the row under a point", () => {
    const offsets = offsetsOf([10, 20, 30]);
    expect(offsets).toEqual([0, 10, 30, 60]);
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, 9)).toBe(0);
    expect(rowAt(offsets, 10)).toBe(1);
    expect(rowAt(offsets, 59)).toBe(2);
    expect(rowAt(offsets, 1000)).toBe(2);
  });
});

describe("visibleRange", () => {
  const offsets = offsetsOf(Array.from({ length: 10_000 }, () => 50));

  test("renders only the viewport plus the overscan", () => {
    expect(visibleRange(offsets, 50_000, 500, 5)).toEqual({ start: 995, end: 1_016 });
  });

  test("is clamped at both ends", () => {
    expect(visibleRange(offsets, 0, 500, 5)).toEqual({ start: 0, end: 16 });
    expect(visibleRange(offsets, 499_800, 500, 5)).toEqual({ start: 9_991, end: 10_000 });
    expect(visibleRange(offsetsOf([]), 0, 500, 5)).toEqual({ start: 0, end: 0 });
  });
});

test("a long list puts only a few rows in the DOM", () => {
  const items = Array.from({ length: 5_000 }, (_, i) => `wiersz-${i}`);
  const html = renderToStaticMarkup(
    <VirtualList items={items} keyOf={(item) => item} render={(item) => item} label="Lista" />,
  );
  expect(html.match(/class="vlist-row"/g)?.length).toBeLessThan(30);
  expect(html).toContain("wiersz-0");
  expect(html).not.toContain("wiersz-4999");
  expect(html).toContain("height:400000px");
});

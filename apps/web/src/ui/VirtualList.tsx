// A small virtualised list: only the rows near the viewport are in the DOM. Row heights are measured with a
// ResizeObserver; rows not seen yet count with an estimate. When rows are added above or a row above the
// viewport changes height, the scroll position is corrected so what is on screen stays put.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The top of every row and, last, the total height. */
export function offsetsOf(heights: readonly number[]): number[] {
  const offsets = [0];
  for (const height of heights) offsets.push((offsets.at(-1) ?? 0) + height);
  return offsets;
}

/** The first row whose bottom lies below `y` (binary search over `offsets`). */
export function rowAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((offsets[middle + 1] ?? 0) <= y) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low);
}

/** The rows to render: the ones in the viewport plus `overscan` on each side; `end` is exclusive. */
export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const first = rowAt(offsets, scrollTop);
  const last = rowAt(offsets, scrollTop + viewport);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan + 1) };
}

export interface Anchor {
  key: string;
  /** Viewport top minus the row's top: positive when the row starts above the viewport. */
  delta: number;
}

/**
 * Where the list should be scrolled after its rows or heights changed: the bottom while it follows new rows,
 * else wherever keeps the anchor row in the same place. Null: leave it. Clamped to what can be scrolled.
 */
export function scrollTarget({
  atBottom,
  anchor,
  keys,
  offsets,
  viewport,
}: {
  atBottom: boolean;
  anchor: Anchor | null;
  keys: readonly string[];
  offsets: readonly number[];
  viewport: number;
}): number | null {
  const max = Math.max(0, (offsets.at(-1) ?? 0) - viewport);
  if (atBottom) return max;
  if (!anchor) return null;
  const index = keys.indexOf(anchor.key);
  if (index < 0) return null;
  return Math.min(max, Math.max(0, (offsets[index] ?? 0) + anchor.delta));
}

/** How close (px) to an edge counts as reaching it. */
const EDGE = 300;

export interface VirtualListProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  estimate?: number;
  overscan?: number;
  /** Scrolls this row into view (once per new key). */
  focusKey?: string | null;
  onReachTop?: () => void;
  onReachBottom?: () => void;
  label: string;
}

function Row({
  rowKey,
  top,
  onHeight,
  children,
}: {
  rowKey: string;
  top: number;
  onHeight: (key: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    onHeight(rowKey, element.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) onHeight(rowKey, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [rowKey, onHeight]);
  return (
    <div ref={ref} className="vlist-row" style={{ transform: `translateY(${top}px)` }}>
      {children}
    </div>
  );
}

export function VirtualList<T>({
  items,
  keyOf,
  render,
  estimate = 80,
  overscan = 8,
  focusKey = null,
  onReachTop,
  onReachBottom,
  label,
}: VirtualListProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [, setMeasured] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(800);
  /** The row the view holds in place: the top row after a user scroll, or the focused row after a jump. */
  const anchor = useRef<Anchor | null>(null);
  /** At the bottom: new rows keep it at the bottom. */
  const atBottom = useRef(focusKey === null);
  const focused = useRef<string | null>(null);
  /** The last scroll position set here, so its scroll event is not taken for the user's. */
  const setByUs = useRef<number | null>(null);

  const keys = items.map(keyOf);
  const offsets = offsetsOf(keys.map((key) => heights.current.get(key) ?? estimate));
  const total = offsets.at(-1) ?? 0;

  const onHeight = useCallback((key: string, height: number) => {
    if (heights.current.get(key) === height) return;
    heights.current.set(key, height);
    setMeasured((n) => n + 1);
  }, []);

  const remember = (top: number) => {
    const index = rowAt(offsets, top);
    const key = keys[index];
    anchor.current = key === undefined ? null : { key, delta: top - (offsets[index] ?? 0) };
  };

  // After every change of rows or heights: keep the bottom, or hold the anchor row where it was. A new focus
  // becomes the anchor, a third down the viewport, so it stays there while the rows around it are measured.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (focusKey !== null && focused.current !== focusKey && keys.includes(focusKey)) {
      focused.current = focusKey;
      atBottom.current = false;
      anchor.current = { key: focusKey, delta: -element.clientHeight / 3 };
    }
    const target = scrollTarget({
      atBottom: atBottom.current,
      anchor: anchor.current,
      keys,
      offsets,
      viewport: element.clientHeight,
    });
    if (target !== null && Math.abs(element.scrollTop - target) > 1) {
      element.scrollTop = target;
      setByUs.current = element.scrollTop;
    }
    if (!anchor.current) remember(element.scrollTop);
    setScrollTop(element.scrollTop);
  });

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    setViewport(element.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const top = element.scrollTop;
    setScrollTop(top);
    if (setByUs.current !== null && Math.abs(top - setByUs.current) <= 1) return;
    setByUs.current = null;
    remember(top);
    atBottom.current = top + element.clientHeight >= total - 4;
    if (top < EDGE) onReachTop?.();
    if (top + element.clientHeight > total - EDGE) onReachBottom?.();
  };

  const { start, end } = visibleRange(offsets, scrollTop, viewport, overscan);
  return (
    <div
      ref={scroller}
      className="vlist"
      onScroll={onScroll}
      role="log"
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the message log scrolls by keyboard
      tabIndex={0}
    >
      <div className="vlist-inner" style={{ height: total }}>
        {items.slice(start, end).map((item, offset) => {
          const index = start + offset;
          const key = keys[index] ?? "";
          return (
            <Row key={key} rowKey={key} top={offsets[index] ?? 0} onHeight={onHeight}>
              {render(item)}
            </Row>
          );
        })}
      </div>
    </div>
  );
}

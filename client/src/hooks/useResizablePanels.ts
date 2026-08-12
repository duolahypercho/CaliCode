import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

/** Pixels one arrow-key press moves the divider. */
const DEFAULT_STEP_PX = 16;
/** Only the primary button drags; right/middle clicks belong to the browser. */
const PRIMARY_BUTTON = 0;

export interface ResizablePanelOptions {
  /** localStorage key the width is remembered under. */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  step?: number;
  /**
   * Set for a panel that sits to the *right* of its handle: the width then
   * grows as the pointer moves left, and ArrowRight narrows it.
   */
  invert?: boolean;
}

export interface ResizablePanel {
  width: number;
  isDragging: boolean;
  /** Attach to the drag handle's onPointerDown. */
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Attach to the drag handle's onKeyDown for arrow-key resizing. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** Back to defaultWidth — wired to double-click on the handle. */
  reset: () => void;
}

export function clampWidth(width: number, minWidth: number, maxWidth: number): number {
  // A max below min would otherwise invert the range and pin every width to max.
  const upper = Math.max(minWidth, maxWidth);
  if (!Number.isFinite(width)) return minWidth;
  return Math.min(upper, Math.max(minWidth, Math.round(width)));
}

interface StoredWidthBounds {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

/**
 * The remembered width, or the default when nothing usable is stored.
 *
 * Always re-clamped on read: the bounds can change between releases, and a
 * width persisted under the old ones would otherwise restore a panel that no
 * longer fits.
 */
export function readStoredWidth(storageKey: string, bounds: StoredWidthBounds): number {
  const fallback = clampWidth(bounds.defaultWidth, bounds.minWidth, bounds.maxWidth);
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return clampWidth(parsed, bounds.minWidth, bounds.maxWidth);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). A panel width
    // is not worth failing the editor over; the default is a fine answer.
    return fallback;
  }
}

export function writeStoredWidth(storageKey: string, width: number): void {
  try {
    localStorage.setItem(storageKey, String(width));
  } catch {
    // Same as above: an unremembered width is a far smaller problem than a throw
    // in the middle of a drag.
  }
}

interface DragOrigin {
  startX: number;
  startWidth: number;
}

/**
 * A pixel width driven by a drag handle, clamped and remembered.
 *
 * Written for a panel that sits to the *left* of its handle, so the width grows
 * as the pointer moves right. Pointer moves are coalesced into one state update
 * per animation frame — a raw pointermove stream can outpace the display and
 * would re-layout the whole editor several times per frame.
 */
export function useResizablePanels(options: ResizablePanelOptions): ResizablePanel {
  const { storageKey, defaultWidth, minWidth, maxWidth, step = DEFAULT_STEP_PX, invert = false } = options;
  const direction = invert ? -1 : 1;

  const [width, setWidth] = useState(() => readStoredWidth(storageKey, { defaultWidth, minWidth, maxWidth }));
  const [isDragging, setIsDragging] = useState(false);

  // Read inside listeners that must not be torn down and rebuilt per pixel.
  const widthRef = useRef(width);
  widthRef.current = width;
  const originRef = useRef<DragOrigin | null>(null);

  // Bounds can move while mounted — the window shrinks, or a neighbouring
  // panel grows and lowers this panel's ceiling. Re-clamp the live width so
  // the layout always fits, but leave storage alone: the remembered width is
  // the user's preference for when the room comes back.
  useEffect(() => {
    setWidth((current) => clampWidth(current, minWidth, maxWidth));
  }, [minWidth, maxWidth]);

  const commit = useCallback(
    (next: number) => {
      const clamped = clampWidth(next, minWidth, maxWidth);
      setWidth(clamped);
      writeStoredWidth(storageKey, clamped);
    },
    [maxWidth, minWidth, storageKey],
  );

  const onDragStart = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== PRIMARY_BUTTON) return;
    event.preventDefault();
    originRef.current = { startX: event.clientX, startWidth: widthRef.current };
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    let frame: number | null = null;
    let pending: number | null = null;

    const flush = () => {
      frame = null;
      if (pending === null) return;
      setWidth(clampWidth(pending, minWidth, maxWidth));
    };

    const onPointerMove = (event: PointerEvent) => {
      const origin = originRef.current;
      if (!origin) return;
      pending = origin.startWidth + direction * (event.clientX - origin.startX);
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };

    const stop = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      // Persist the last pointer position even if its frame never ran.
      if (pending !== null) commit(pending);
      pending = null;
      originRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);

    // Without this the drag selects text across the whole editor and the cursor
    // flickers back to default whenever it leaves the 5px handle.
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [commit, direction, isDragging, maxWidth, minWidth]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const delta = (event.key === "ArrowRight" ? step : -step) * direction;
      commit(widthRef.current + delta);
    },
    [commit, direction, step],
  );

  const reset = useCallback(() => commit(defaultWidth), [commit, defaultWidth]);

  return { width, isDragging, onDragStart, onKeyDown, reset };
}

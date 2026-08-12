/**
 * Where everything goes at a given terminal size.
 *
 * Three widths change the shape of the interface, and each of them is here
 * rather than in the component that reacts to it, so that the snapshot and the
 * running interface cannot disagree about where a window is.
 */
import type { TuiSize } from "./state.js";

/** A rectangle of the grid, in cells, measured from the top left. */
export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** The vertical rail: twelve columns of names and one of gap. */
export const RAIL_WIDTH = 13;

/** Below this the rail lies across the top instead, to keep the body wide. */
export const WIDE_RAIL_FROM = 100;

/** From here a detail panel sits beside its list rather than over it. */
export const SPLIT_FROM = 150;

/** How much of the body the list keeps when a detail panel is beside it. */
const LIST_SHARE = 0.56;

/** The gap between a list and the detail panel beside it. */
const SPLIT_GAP = 2;

export interface Frame {
  readonly wideRail: boolean;
  readonly split: boolean;
  /** The row the body starts on: under the header, and under the rail when it is a strip. */
  readonly bodyTop: number;
  readonly bodyLeft: number;
  readonly bodyWidth: number;
  readonly bodyHeight: number;
  /** The list's width, which is the whole body unless a panel is beside it. */
  readonly listWidth: number;
  readonly detailLeft: number;
  readonly detailWidth: number;
}

/** Work out the shape of the screen at one size. */
export function frameOf(size: TuiSize): Frame {
  const wideRail = size.columns >= WIDE_RAIL_FROM;
  const split = size.columns >= SPLIT_FROM;
  const bodyLeft = wideRail ? RAIL_WIDTH : 0;
  const bodyWidth = Math.max(1, size.columns - bodyLeft);
  const bodyTop = wideRail ? 1 : 2;
  const bodyHeight = Math.max(1, size.rows - (wideRail ? 2 : 3));
  const listWidth = split ? Math.floor(bodyWidth * LIST_SHARE) : bodyWidth;
  const detailWidth = split ? Math.max(1, bodyWidth - listWidth - SPLIT_GAP) : bodyWidth;
  return {
    wideRail,
    split,
    bodyTop,
    bodyLeft,
    bodyWidth,
    bodyHeight,
    listWidth,
    detailLeft: bodyLeft + listWidth + SPLIT_GAP,
    detailWidth,
  };
}

/**
 * Put a window of a given size in the middle of the screen.
 *
 * Never on the first row, which the header owns, and never over the last,
 * which is where the keys are: an operator who has lost their way needs the
 * way out to still be legible.
 */
export function centred(size: TuiSize, width: number, height: number): Rect {
  const capped = Math.min(height, Math.max(1, size.rows - 2));
  return {
    width: Math.max(1, Math.min(width, size.columns)),
    height: capped,
    left: Math.max(0, Math.floor((size.columns - width) / 2)),
    top: Math.max(1, Math.floor((size.rows - capped) / 2)),
  };
}

/** A window that takes the whole body, which is what a narrow terminal gets. */
export function overBody(size: TuiSize): Rect {
  const frame = frameOf(size);
  return { top: frame.bodyTop, left: 0, width: size.columns, height: frame.bodyHeight };
}

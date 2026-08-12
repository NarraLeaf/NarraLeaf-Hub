/**
 * The one thing every part of this interface draws: a line of styled text
 * exactly as wide as the space it is given.
 *
 * Every panel is built as an array of these before anything is rendered, which
 * is what makes the two failures this interface is measured against
 * impossible rather than unlikely. A line that is already the right width
 * cannot be wrapped by the terminal, and a panel whose lines were counted
 * before it was drawn cannot be given more of them than it has room for.
 */

/** A run of characters drawn with one style. */
export interface Span {
  readonly text: string;
  /** An Ink colour name; absent leaves the terminal's own foreground. */
  readonly color?: string;
  readonly dim?: boolean;
  readonly bold?: boolean;
  /** Foreground and background swapped, which is how a selected row is drawn. */
  readonly inverse?: boolean;
}

/** One line of a panel, before it is given a width. */
export type Line = readonly Span[];

/** A line of one style. */
export function span(text: string, style: Omit<Span, "text"> = {}): Line {
  return [{ text, ...style }];
}

/** An empty line, which still has to be there to occupy its row. */
export const BLANK: Line = [];

/** The characters of a line with its styling dropped. */
export function plainText(line: Line): string {
  return line.map((part) => part.text).join("");
}

/** How many characters wide a line is. */
export function lineWidth(line: Line): number {
  return [...plainText(line)].length;
}

/**
 * Cut or pad a line to exactly `width` characters.
 *
 * Padding is deliberate rather than left to the terminal: an overlay is drawn
 * over a surface, and a cell an overlay does not write to shows whatever is
 * underneath it. Spaces the window writes for itself are what make it opaque,
 * with or without a background colour.
 */
export function fitLine(line: Line, width: number): Line {
  if (width <= 0) {
    return BLANK;
  }
  const out: Span[] = [];
  let used = 0;
  for (const part of line) {
    if (used >= width) {
      break;
    }
    const characters = [...part.text];
    const take = Math.min(characters.length, width - used);
    out.push({ ...part, text: characters.slice(0, take).join("") });
    used += take;
  }
  if (used < width) {
    out.push({ text: " ".repeat(width - used) });
  }
  return out;
}

/**
 * Give a block of lines exactly `rows` of them.
 *
 * Blank lines are added at the end rather than the middle, and anything past
 * the end is dropped here, where the caller decided what order to lose things
 * in, rather than by a flexbox that would take a row out of the middle.
 */
export function fitBlock(lines: readonly Line[], rows: number, width: number): Line[] {
  const out: Line[] = [];
  for (let index = 0; index < rows; index += 1) {
    out.push(fitLine(lines[index] ?? BLANK, width));
  }
  return out;
}

/**
 * The rows of a list that are on screen when `selected` has to be among them.
 *
 * Scrolling is by whole rows and only as far as it must be, so that a list
 * that fits does not move at all.
 */
export function visibleWindow(count: number, rows: number, selected: number): { first: number; last: number } {
  if (rows <= 0 || count <= 0) {
    return { first: 0, last: 0 };
  }
  if (count <= rows) {
    return { first: 0, last: count };
  }
  const wanted = Math.min(Math.max(selected, 0), count - 1);
  const first = Math.min(Math.max(0, wanted - rows + 1), count - rows);
  return { first, last: first + rows };
}

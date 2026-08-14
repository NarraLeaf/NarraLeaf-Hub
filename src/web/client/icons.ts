/**
 * Every mark this interface draws.
 *
 * They are here rather than beside the screens that use them for one reason:
 * an icon is a fact about a thing — a project is a folder, a member is a
 * person — and the same thing is named on more than one surface. The rail says
 * projects and so does the overview's first number, and they must not be able
 * to disagree.
 *
 * All of them are drawn rather than fetched. The page's content security policy
 * allows no image from anywhere, and a mark that arrives as markup takes its
 * colour from the text it sits beside — `currentColor` in the stylesheet — so
 * none of them is drawn twice for the two themes.
 *
 * They are strokes on a sixteen-pixel grid and nothing else — the logo, which
 * arrives on its own grid, is the one exception and the reason there is one:
 * no fills, no
 * second colour, no detail that survives being drawn at fourteen pixels on a
 * screen that is not retina. What that rules out is most of what an icon set
 * usually is. A gear at this size is a grey smudge, so settings is two sliders;
 * a padlock and a shield read the same at a glance, so only one of them is
 * here. When a mark cannot be drawn this plainly, the answer is a word.
 *
 * Every one of them is `aria-hidden` — see {@link icon} — because each sits
 * beside the word it illustrates or on a control that names itself. A rail
 * folded down to icons is the one place the words are gone, and there the
 * button carries the word as its label rather than the mark being announced.
 */
import { BRAND_PATHS, BRAND_VIEWBOX } from "../../brand.js";
import { icon, iconIn } from "./dom.js";

/** One mark, made fresh: a redraw builds the whole document again. */
export type Mark = () => SVGSVGElement;

/**
 * The logo, which is the only mark here that is a name rather than a noun — and
 * the only one not drawn for this interface.
 *
 * It comes from src/brand.ts on its own grid, at its own weight, because it is
 * the product's mark and not ours to redraw at sixteen pixels. It sits in the
 * corner of the rail, and it is what is left of the name when the rail is
 * folded: a strip of icons with nothing at the top of it is a strip of icons
 * belonging to no program in particular.
 */
export const brand: Mark = () => iconIn(BRAND_VIEWBOX, "icon icon-brand", ...BRAND_PATHS);

/** The overview: the four panels the screen itself is. */
export const overview: Mark = () =>
  icon(
    "icon",
    "M2.75 2.75h4v4h-4z",
    "M9.25 2.75h4v4h-4z",
    "M2.75 9.25h4v4h-4z",
    "M9.25 9.25h4v4h-4z",
  );

/** A project: the folder it is on the disk it is stored on. */
export const projects: Mark = () =>
  icon(
    "icon",
    "M2.25 12.25V4.25c0-.41.34-.75.75-.75h2.9l1.5 1.7H13c.41 0 .75.34.75.75v6.3c0 .41-.34.75-.75.75H3c-.41 0-.75-.34-.75-.75Z",
  );

/** A member, and behind them the rest of them. */
export const members: Mark = () =>
  icon(
    "icon",
    "M6 8.1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
    "M1.75 13.4c0-2.25 1.9-3.65 4.25-3.65s4.25 1.4 4.25 3.65",
    "M10.6 3.5a2.2 2.2 0 0 1 0 4.3",
    "M12 10c1.35.4 2.25 1.4 2.25 3.1",
  );

/**
 * A decision: a shield, and the tick or the absence of one.
 *
 * The mark is the same whichever way the decision went. What a row says is in
 * the row — allowed, refused, and the sentence the authorization service wrote
 * down — and a mark that changed with it would be the third place a person had
 * to look to find out one thing.
 */
export const decisions: Mark = () =>
  icon(
    "icon",
    "M8 1.9 3.25 3.6v4.1c0 2.9 1.95 5 4.75 6.4 2.8-1.4 4.75-3.5 4.75-6.4V3.6L8 1.9Z",
    "M5.9 7.9 7.4 9.4l2.9-3",
  );

/** Settings: two sliders, because a gear this small is a smudge. */
export const settings: Mark = () =>
  icon(
    "icon",
    "M2.5 5h3.2",
    "M8.9 5h4.6",
    "M8.9 5a1.6 1.6 0 1 0-3.2 0 1.6 1.6 0 0 0 3.2 0Z",
    "M2.5 11h5.6",
    "M11.3 11h2.2",
    "M11.3 11a1.6 1.6 0 1 0-3.2 0 1.6 1.6 0 0 0 3.2 0Z",
  );

/** An invitation: the envelope it is not actually sent in. */
export const invites: Mark = () =>
  icon(
    "icon",
    "M2.25 4.5c0-.55.45-1 1-1h9.5c.55 0 1 .45 1 1v7c0 .55-.45 1-1 1h-9.5c-.55 0-1-.45-1-1z",
    "M2.6 4.9 8 8.8l5.4-3.9",
  );

/** A signing key. */
export const keys: Mark = () =>
  icon(
    "icon",
    "M13 5.6a2.6 2.6 0 1 0-5.2 0 2.6 2.6 0 0 0 5.2 0Z",
    "M8.6 7.4 3 13",
    "M4.4 10.4 6 12",
  );

/**
 * The rail itself, folded and unfolded.
 *
 * A panel with its edge marked, which is the mark for this everywhere, and it
 * is deliberately the same in both states: what it does depends on which state
 * the rail is in, and that is what the button's label says. An arrow here would
 * have to point one way when it means fold and the other when it means unfold,
 * and a mark that changes under the cursor is a mark nobody learns.
 */
export const panel: Mark = () =>
  icon(
    "icon",
    "M2.75 3.25h10.5c.55 0 1 .45 1 1v7.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-7.5c0-.55.45-1 1-1Z",
    "M6.25 3.25v9.5",
  );

/** Signing out: the way out, and the door it is out of. */
export const signOut: Mark = () =>
  icon(
    "icon",
    "M9.5 2.75H4.25c-.55 0-1 .45-1 1v8.5c0 .55.45 1 1 1H9.5",
    "M7.5 8h6.5",
    "M11.5 5.5 14 8l-2.5 2.5",
  );

/**
 * A globe: the one mark that means "language" without being written in one.
 *
 * Three strokes — the outline, the equator and a meridian — because at fourteen
 * pixels anything more is a grey smudge.
 */
export const globe: Mark = () =>
  icon(
    "icon icon-globe",
    "M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
    "M1.5 8h13",
    "M8 1.5c1.8 1.8 2.8 4 2.8 6.5S9.8 12.7 8 14.5C6.2 12.7 5.2 10.5 5.2 8S6.2 3.3 8 1.5Z",
  );

/**
 * The chevron, drawn pointing down.
 *
 * A path rather than a rotated square with two borders, which is the usual
 * trick and which nobody can read: what direction a rotated corner ends up
 * pointing in is four lines of arithmetic away from what the stylesheet says,
 * and it was pointing the wrong way. Here it points down, the stylesheet turns
 * it when it should point elsewhere, and both facts are legible.
 */
export const chevron: Mark = () => icon("icon icon-chevron", "M4.5 6.5 8 10l3.5-3.5");

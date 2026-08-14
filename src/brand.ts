/**
 * The NarraLeaf logo, as coordinates.
 *
 * The mark on narraleaf.com, transcribed: two open strokes on a 96-unit grid —
 * the leaf's outline, which is not a closed shape, and the vein inside it. It
 * is the product's own mark rather than a leaf this interface drew, and both
 * places that show one take it from here: the corner of the rail, in the
 * browser, and the icon a tab is labelled with, which is served by the server.
 * Neither can drift from the other, which is the reason this file exists rather
 * than the paths being written twice.
 *
 * Here rather than beside either of them because those two live on opposite
 * sides of the program: src/web/client is the only place the DOM exists and the
 * only place the executable may not reach into. This module is coordinates and
 * nothing else, so both may have it.
 *
 * The colour is the logo's own, sampled from it, and it is the same #40a8c4
 * the stylesheet is built around — the brand colour was the anchor of that
 * palette before this file existed. Where the mark sits on a surface that can
 * carry a theme it takes {@link BRAND_COLOUR} through `currentColor` rather
 * than naming it, so one value stays one value.
 *
 * If the logo is ever redrawn, this is the one thing to replace: re-trace it at
 * whatever grid it comes on, set the three constants, and every size it is
 * shown at follows.
 */

/** The grid the strokes below are drawn on. */
export const BRAND_VIEWBOX = "0 0 96 96";

/** The weight of those strokes, on that grid. */
export const BRAND_STROKE = 5;

/** The one colour the mark is drawn in. */
export const BRAND_COLOUR = "#40a8c4";

/**
 * The outline, and the vein.
 *
 * Open paths, both of them, with rounded ends: the leaf is not closed at the
 * bottom and the vein is a single stroke that stops. Drawn with a round join
 * as well, for the one corner in it — where the top edge meets the right.
 */
export const BRAND_PATHS: readonly string[] = [
  "M12.6 75.2C10.4 61.6 11 48.8 14.8 38.6 18.6 28.4 25.8 19.8 35.8 14.8 " +
    "40.6 12.4 45.8 11.3 51 11.4 57.2 11.5 63.4 12.6 69.2 13.3 " +
    "74.6 13.9 79.4 13.3 83.4 11.4 84 24.4 83.6 35.6 81 44.6 " +
    "77.8 55.8 71.2 64.8 61.2 70.4 53.6 74.6 45 76.4 36.4 76.4",
  "M19.4 87.6C18.6 77 21 66.8 26.2 59 31 51.4 37.6 44.8 44.8 40.2",
];

/**
 * The mark trimmed to its ink, for somewhere it is shown alone and small.
 *
 * A tab's icon is sixteen pixels across and the grid above spends a tenth of
 * its width on air. Same paths, same coordinates — only the window onto them is
 * tighter, which is what the product's own favicon does too.
 */
export const BRAND_VIEWBOX_TIGHT = "5 7 84 84";

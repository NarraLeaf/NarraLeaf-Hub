/**
 * The pages, carried inside the executable.
 *
 * `__NLTEAM_WEB_JS__` and `__NLTEAM_WEB_CSS__` are not runtime globals. The
 * browser half of the interface is built first, into memory, and both
 * identifiers are replaced with string literals while the server bundle is
 * built around them — see the two passes in scripts/build.mjs, mirrored in
 * vitest.config.ts so a test run has something to serve.
 *
 * Inlining rather than writing files beside dist/nlteam.js is the same decision
 * src/version.ts makes about the version number, for the same reason: the
 * executable never has to work out where it is on disk in order to answer a
 * request. It also means there is no state in which the server is running and
 * its pages are missing, half-built or left over from a previous version.
 *
 * The shell below is written by hand and stays that way. It carries no styling
 * of its own and no text a person reads, so that everything on screen comes
 * from one place.
 */
import { createHash } from "node:crypto";

import {
  BRAND_COLOUR,
  BRAND_PATHS,
  BRAND_STROKE,
  BRAND_VIEWBOX_TIGHT,
} from "../brand.js";

declare const __NLTEAM_WEB_JS__: string;
declare const __NLTEAM_WEB_CSS__: string;

/** The script for the interface, already bundled and minified. */
export const WEB_JS: string = __NLTEAM_WEB_JS__;

/** Its styles. */
export const WEB_CSS: string = __NLTEAM_WEB_CSS__;

/**
 * Whether this build has an interface in it at all.
 *
 * False under the type checker and in a test run that did not build the client.
 * The router says so in a sentence rather than serving an empty page, because
 * an empty page looks like a server that is broken.
 */
export const WEB_BUILT: boolean = WEB_JS.length > 0;

/**
 * The one document a browser is served.
 *
 * The policy is the interesting part. `default-src 'none'` means nothing loads
 * unless it is named below, so this page cannot be made to fetch a font, an
 * analytics script or an image from anywhere at all — and a self-hosted server
 * on somebody's own network is exactly where that matters, because a page that
 * reached outward would be reporting on a private deployment. `script-src` and
 * `style-src` name `'self'` and not `'unsafe-inline'`, which is why the script
 * and the styles are two files here rather than two tags.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <meta
      http-equiv="content-security-policy"
      content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    />
    <meta name="referrer" content="no-referrer" />
    <title>NarraLeaf Team</title>
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;

/**
 * The tab's mark: the product's own logo, in the one colour it owns.
 *
 * Drawn rather than fetched, for the reason the policy above exists — a tab
 * icon loaded from a content delivery network would be this page's one request
 * to the outside, made by every browser that ever opened a private deployment.
 * The coordinates are src/brand.ts, which the rail's corner draws from as well,
 * so the tab and the page cannot end up showing two different leaves.
 *
 * The colour is written in rather than inherited: a favicon is drawn by the
 * browser outside any page, where `currentColor` is black.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_VIEWBOX_TIGHT}" fill="none" stroke="${BRAND_COLOUR}" stroke-width="${BRAND_STROKE}" stroke-linecap="round" stroke-linejoin="round">
${BRAND_PATHS.map((path) => `  <path d="${path}"/>`).join("\n")}
</svg>
`;

/** One asset the server can hand over without thinking about it. */
export interface StaticAsset {
  readonly body: string;
  readonly type: string;
  /**
   * A strong tag over the contents, so a page that already has this exact file
   * is answered 304 rather than sent it again. It changes when the build does,
   * which is what makes it safe to let a browser keep the file for a while.
   */
  readonly etag: string;
}

function asset(body: string, type: string): StaticAsset {
  return {
    body,
    type,
    etag: `"${createHash("sha256").update(body, "utf8").digest("base64url").slice(0, 27)}"`,
  };
}

/** Everything served by path, and nothing else is. */
export function staticAssets(): ReadonlyMap<string, StaticAsset> {
  return new Map([
    ["/", asset(INDEX_HTML, "text/html; charset=utf-8")],
    ["/app.js", asset(WEB_JS, "text/javascript; charset=utf-8")],
    ["/app.css", asset(WEB_CSS, "text/css; charset=utf-8")],
    ["/icon.svg", asset(ICON_SVG, "image/svg+xml; charset=utf-8")],
  ]);
}

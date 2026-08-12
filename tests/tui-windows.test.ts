// Where a window goes, and what the one that matters says.
//
// The geometry is worked out in one place because the interface draws from it
// and the snapshot reports it; anything that read the size twice could pass
// every assertion about a rectangle while drawing the window somewhere else.
import { describe, expect, it } from "vitest";

import { frameOf, SPLIT_FROM, WIDE_RAIL_FROM } from "../src/tui/layout.js";
import { plainText } from "../src/tui/text.js";
import { overlayWindow } from "../src/tui/window.js";
import { FIXTURE_VIEW } from "./fixtures/hubview.js";

const SMALL = { columns: 80, rows: 24 };
const MIDDLING = { columns: 120, rows: 40 };
const LARGE = { columns: 200, rows: 60 };

const REVOKE = { kind: "revoke-tokens", username: "cleo" } as const;
const DETAIL = { kind: "project-detail", project: "harbour" } as const;

describe("a detail panel changes shape with the width", () => {
  it("takes the whole body where there is no room to float", () => {
    expect(SMALL.columns).toBeLessThan(WIDE_RAIL_FROM);
    const window = overlayWindow(DETAIL, SMALL, FIXTURE_VIEW);

    const frame = frameOf(SMALL);
    expect(window?.rect).toEqual({
      top: frame.bodyTop,
      left: 0,
      width: SMALL.columns,
      height: frame.bodyHeight,
    });
  });

  it("floats over the middle where there is", () => {
    const window = overlayWindow(DETAIL, MIDDLING, FIXTURE_VIEW);

    expect(window?.rect.left).toBeGreaterThan(0);
    expect(window?.rect.width).toBeLessThan(MIDDLING.columns);
  });

  it("draws none at all where the panel sits beside the list", () => {
    expect(LARGE.columns).toBeGreaterThanOrEqual(SPLIT_FROM);
    expect(overlayWindow(DETAIL, LARGE, FIXTURE_VIEW)).toBeUndefined();
  });

  it("draws nothing for a project that is not there, rather than an empty box", () => {
    expect(
      overlayWindow({ kind: "project-detail", project: "nowhere" }, SMALL, FIXTURE_VIEW),
    ).toBeUndefined();
  });
});

describe("a window is the size of what is in it", () => {
  for (const size of [SMALL, MIDDLING, LARGE]) {
    it(`fits its own lines at ${size.columns}x${size.rows}`, () => {
      const window = overlayWindow(REVOKE, size, FIXTURE_VIEW);
      expect(window).toBeDefined();
      const { rect, lines, title, footer } = window!;

      // Border, title and footer, and then one row for each line. A window
      // shorter than this loses a row out of its middle without a mark.
      expect(rect.height).toBe(lines.length + 4);

      const widest = Math.max(
        ...lines.map((line) => [...plainText(line)].length),
        [...title].length,
        [...footer].length,
      );
      expect(widest).toBeLessThanOrEqual(rect.width - 4);
    });

    it(`keeps clear of the header and the keys at ${size.columns}x${size.rows}`, () => {
      const window = overlayWindow(REVOKE, size, FIXTURE_VIEW);
      expect(window!.rect.top).toBeGreaterThanOrEqual(1);
      expect(window!.rect.top + window!.rect.height).toBeLessThanOrEqual(size.rows - 1);
      expect(window!.rect.left + window!.rect.width).toBeLessThanOrEqual(size.columns);
    });
  }
});

describe("the confirmation for revoking somebody's tokens", () => {
  // The pair an operator gets wrong. Hub refuses a stale token wherever Hub is
  // the one asked; a data connection already open is checked by loreserver
  // rather than by Hub, and may last until the token it was opened with
  // expires. Both halves have to be on screen, and nothing else.
  const window = overlayWindow(REVOKE, MIDDLING, FIXTURE_VIEW);
  const said = window!.lines.map((line) => plainText(line)).join(" ");

  it("names the account in the question", () => {
    expect(window!.title).toBe("Revoke every token issued to cleo?");
  });

  it("says what stops", () => {
    expect(said).toContain("Every token Hub has issued stops being accepted.");
  });

  it("says what does not", () => {
    expect(said).toContain("An open connection may last until its token expires.");
  });

  it("states the consequence rather than asking whether somebody is sure", () => {
    expect(said.toLowerCase()).not.toContain("are you sure");
    expect(window!.footer).toContain("esc cancel");
  });
});

describe("the editor", () => {
  it("opens on the value as it stands, and shows why the value is worth thinking about", () => {
    const window = overlayWindow({ kind: "edit-setting", index: 1 }, MIDDLING, FIXTURE_VIEW);
    const said = window!.lines.map((line) => plainText(line)).join(" ");

    expect(window!.title).toBe("repository token");
    expect(said).toContain("15 minutes");
    expect(said).toContain("revoking access cannot cut it short");
  });

  it("opens on nothing for a row that cannot be written", () => {
    const readOnly = FIXTURE_VIEW.settings.findIndex((setting) => !setting.editable);
    expect(
      overlayWindow({ kind: "edit-setting", index: readOnly }, MIDDLING, FIXTURE_VIEW),
    ).toBeUndefined();
  });
});

// The words the interface puts on screen, tested without one.
//
// Every function here is a pure one, and each of these is about a value that
// is easy to render into something that looks right and says the wrong thing:
// a size in the wrong multiple, a fingerprint given a label it never had, a
// sentence that would have wrapped inside a window sized before it did.
import { describe, expect, it } from "vitest";

import {
  ellipsis,
  fileSize,
  groupDigits,
  plural,
  relativeTime,
  shortDate,
  shortFingerprint,
  shortUptime,
  clockTime,
  uptime,
  UNKNOWN,
  withoutScheme,
  wrapText,
} from "../src/tui/format.js";

const NOW = Date.parse("2026-08-12T14:03:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("counts back from the moment the view was gathered", () => {
    expect(relativeTime(NOW - 2000, NOW)).toBe("2s ago");
    expect(relativeTime(NOW - 11 * MINUTE, NOW)).toBe("11m ago");
    expect(relativeTime(NOW - 2 * HOUR, NOW)).toBe("2h ago");
    expect(relativeTime(NOW - 26 * HOUR, NOW)).toBe("yesterday");
    expect(relativeTime(NOW - 6 * DAY, NOW)).toBe("6d ago");
  });

  it("says unknown for a moment nobody recorded", () => {
    expect(relativeTime(undefined, NOW)).toBe(UNKNOWN);
  });

  it("does not count forwards", () => {
    // A clock a few seconds out is far likelier than an event ahead of the
    // view it is in, and "in -3s" helps nobody.
    expect(relativeTime(NOW + 3000, NOW)).toBe("just now");
  });
});

describe("dates and durations", () => {
  it("writes a date in UTC, so the screen does not depend on where it is read", () => {
    expect(shortDate(Date.parse("2026-07-02T23:40:00Z"))).toBe("2026-07-02");
    expect(clockTime(Date.parse("2026-07-02T23:40:07Z"))).toBe("23:40:07");
    expect(shortDate(undefined)).toBe(UNKNOWN);
  });

  it("separates the days of an uptime from its clock", () => {
    expect(uptime(3 * DAY + 4 * HOUR + 12 * MINUTE)).toBe("3d 04:12");
    expect(uptime(4 * HOUR + 12 * MINUTE)).toBe("04:12");
    expect(shortUptime(3 * DAY + 4 * HOUR)).toBe("3d");
  });
});

describe("fileSize", () => {
  it("uses the multiple every other tool on the same directory reports", () => {
    expect(fileSize(2_576_980_378)).toBe("2.4 GB");
    expect(fileSize(325_058_560)).toBe("310 MB");
    expect(fileSize(0)).toBe("0 B");
  });

  it("says unknown rather than nothing", () => {
    expect(fileSize(undefined)).toBe(UNKNOWN);
  });
});

describe("counts", () => {
  it("groups the digits of a long one", () => {
    expect(groupDigits(1284)).toBe("1 284");
    expect(groupDigits(42)).toBe("42");
  });

  it("agrees with the noun it counts", () => {
    expect(plural(1, "invite")).toBe("1 invite");
    expect(plural(4, "project")).toBe("4 projects");
    expect(plural(4, "repository", "repositories")).toBe("4 repositories");
  });
});

describe("shortening", () => {
  it("marks text that was cut", () => {
    expect(ellipsis("harbour", 7)).toBe("harbour");
    expect(ellipsis("lighthouse", 6)).toBe("light…");
  });

  it("keeps the label a fingerprint came with, and adds none it did not", () => {
    // The label is part of what somebody compares, so one invented here would
    // be a claim about which digest this is.
    expect(shortFingerprint("SHA256:2f:a1:9c:7d:04:bb")).toBe("SHA256:2f:a1:9c:…");
    expect(shortFingerprint("22:3B:65:91:89:41")).toBe("22:3B:65:…");
  });

  it("takes the scheme off an address, keeping what somebody has to type", () => {
    expect(withoutScheme("lore://team.example.com:41337")).toBe("team.example.com:41337");
    expect(withoutScheme("team.example.com:41402")).toBe("team.example.com:41402");
  });
});

describe("wrapText", () => {
  // Ink would wrap a long line itself, and a line that wrapped inside a window
  // is one the window was not sized for: the row it pushes off the bottom
  // disappears without a mark. Wrapping here is what lets the caller count the
  // lines before drawing them.
  it("breaks on words and never exceeds the width", () => {
    const lines = wrapText("An open connection may last until its token expires.", 24);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(24);
    }
    expect(lines.join(" ")).toBe("An open connection may last until its token expires.");
  });

  it("cuts a word too long for the width rather than overflowing", () => {
    expect(wrapText("supercalifragilistic", 8)).toEqual(["superca…"]);
  });
});

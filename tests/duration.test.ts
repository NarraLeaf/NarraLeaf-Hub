import { describe, expect, it } from "vitest";

import { describeDuration } from "../src/duration.js";
import { DEFAULT_IDENTITY } from "../src/identity/config.js";

describe("describeDuration", () => {
  it("uses the largest unit the duration divides into exactly", () => {
    expect(describeDuration(30 * 24 * 60 * 60)).toBe("30 days");
    expect(describeDuration(2 * 60 * 60)).toBe("2 hours");
    expect(describeDuration(15 * 60)).toBe("15 minutes");
    expect(describeDuration(45)).toBe("45 seconds");
  });

  it("says one of something rather than 1 of them", () => {
    expect(describeDuration(24 * 60 * 60)).toBe("1 day");
    expect(describeDuration(60 * 60)).toBe("1 hour");
    expect(describeDuration(60)).toBe("1 minute");
    expect(describeDuration(1)).toBe("1 second");
  });

  it("drops to a smaller unit rather than rounding to a nearer one", () => {
    // The reader may be holding this up against a number they set, and a
    // rounded one matches nothing they could have typed.
    expect(describeDuration(90 * 60)).toBe("90 minutes");
    expect(describeDuration(36 * 60 * 60)).toBe("36 hours");
  });

  it("never renders a month-long lifetime in minutes", () => {
    // The failure this exists to stop: a lifetime that moved from a quarter of
    // an hour to thirty days, printed by arithmetic that assumed minutes and
    // came out as 43200 of them.
    const rendered = describeDuration(DEFAULT_IDENTITY.signInTokenLifetimeSeconds);

    expect(rendered).toBe("30 days");
    expect(rendered).not.toContain("minute");
  });
});

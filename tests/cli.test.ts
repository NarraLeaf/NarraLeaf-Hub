import { describe, expect, it } from "vitest";

import { USAGE, run } from "../src/cli.js";

/** Runs a command line and collects everything written to each stream. */
function invoke(argv: readonly string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = run(
    argv,
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, out, err };
}

describe("run", () => {
  it("prints the version alone, so a script can read it unedited", () => {
    const { code, out, err } = invoke(["--version"]);

    expect(code).toBe(0);
    expect(err).toBe("");
    // The exact number moves with every release; that it stands by itself,
    // with no label and no second line, is the part callers depend on.
    expect(out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("prints usage for --help and succeeds", () => {
    const { code, out, err } = invoke(["--help"]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(`${USAGE}\n`);
    expect(out).toContain("Usage: nlhub");
  });

  it("fails with one line on stderr for an unknown argument", () => {
    const { code, out, err } = invoke(["--nonsense"]);

    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err).toBe("nlhub: unknown argument: --nonsense\n");
  });
});

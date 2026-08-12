import { describe, expect, it } from "vitest";

import { USAGE, run } from "../src/cli.js";

/** Runs a command line and collects everything written to each stream. */
async function invoke(
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await run(
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
  it("prints the version alone, so a script can read it unedited", async () => {
    const { code, out, err } = await invoke(["--version"]);

    expect(code).toBe(0);
    expect(err).toBe("");
    // The exact number moves with every release; that it stands by itself,
    // with no label and no second line, is the part callers depend on.
    expect(out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("prints usage for --help and succeeds", async () => {
    const { code, out, err } = await invoke(["--help"]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(`${USAGE}\n`);
    expect(out).toContain("Usage: nlhub");
  });

  it("documents the up command and its options", async () => {
    const { out } = await invoke(["--help"]);

    expect(out).toContain("up");
    expect(out).toContain("--root");
    expect(out).toContain("--data-port");
    expect(out).toContain("--health-port");
  });

  it("fails with one line on stderr for an unknown argument", async () => {
    const { code, out, err } = await invoke(["--nonsense"]);

    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err).toBe("nlhub: unknown argument: --nonsense\n");
  });

  it("rejects an unusable up command line before it touches anything", async () => {
    // No root means no storage to create and nothing to download, so this
    // returns without a network request or a directory appearing anywhere.
    const { code, out, err } = await invoke(["up"]);

    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("--root");
  });
});

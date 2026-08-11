import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("recognises the long and short spellings of --version", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
  });

  it("recognises the long and short spellings of --help", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("treats an empty command line as a request for help", () => {
    expect(parseArgs([])).toEqual({ kind: "help" });
  });

  it("reports an unknown argument and names it", () => {
    const result = parseArgs(["--nonsense"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("--nonsense");
  });

  it("rejects a trailing argument that no option or command can consume", () => {
    const result = parseArgs(["--version", "stray"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("stray");
  });
});

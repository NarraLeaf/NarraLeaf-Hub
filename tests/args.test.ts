import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";
import { DEFAULT_PORTS } from "../src/loreserver/layout.js";

/** The error message from a command line that was not understood. */
function messageFor(argv: readonly string[]): string {
  const result = parseArgs(argv);
  expect(result.kind).toBe("error");
  return result.kind === "error" ? result.message : "";
}

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

  it("calls a word that is not a command a command", () => {
    expect(messageFor(["dance"])).toBe("unknown command: dance");
  });
});

describe("parseArgs, up", () => {
  it("takes a root and fills in the default ports", () => {
    expect(parseArgs(["up", "--root", "/srv/hub"])).toEqual({
      kind: "up",
      root: "/srv/hub",
      dataPort: DEFAULT_PORTS.dataPort,
      healthPort: DEFAULT_PORTS.healthPort,
    });
  });

  it("accepts ports on the command line", () => {
    expect(parseArgs(["up", "--root", "/srv/hub", "--data-port", "9000"])).toMatchObject({
      dataPort: 9000,
      healthPort: DEFAULT_PORTS.healthPort,
    });
    expect(parseArgs(["up", "--root", "/srv/hub", "--health-port", "9001"])).toMatchObject({
      dataPort: DEFAULT_PORTS.dataPort,
      healthPort: 9001,
    });
  });

  it("accepts a value joined to its option with an equals sign", () => {
    expect(parseArgs(["up", "--root=/srv/hub", "--data-port=9000"])).toMatchObject({
      root: "/srv/hub",
      dataPort: 9000,
    });
  });

  it("keeps a Windows path intact, backslashes and all", () => {
    expect(parseArgs(["up", "--root", "D:\\srv\\hub"])).toMatchObject({ root: "D:\\srv\\hub" });
  });

  it("insists on a root, because there is no sensible default for one", () => {
    expect(messageFor(["up"])).toContain("--root");
    expect(messageFor(["up", "--data-port", "9000"])).toContain("--root");
  });

  it("rejects a port that is not one", () => {
    expect(messageFor(["up", "--root", "/srv/hub", "--data-port", "http"])).toContain(
      "needs a port number",
    );
    expect(messageFor(["up", "--root", "/srv/hub", "--data-port", "0"])).toContain("between 1");
    expect(messageFor(["up", "--root", "/srv/hub", "--data-port", "70000"])).toContain(
      "between 1",
    );
    expect(messageFor(["up", "--root", "/srv/hub", "--health-port", "1.5"])).toContain(
      "needs a port number",
    );
  });

  it("rejects one port doing both jobs", () => {
    // gRPC and QUIC share a number because they are on different transports.
    // The health check is HTTP, on the same transport as gRPC.
    expect(
      messageFor(["up", "--root", "/srv/hub", "--data-port", "9000", "--health-port", "9000"]),
    ).toContain("cannot both be 9000");
  });

  it("reports an option with nothing after it", () => {
    expect(messageFor(["up", "--root"])).toContain("--root needs a value");
  });

  it("reports an option it does not have", () => {
    expect(messageFor(["up", "--root", "/srv/hub", "--verbose"])).toContain("--verbose");
  });

  it("answers --help after the command with help", () => {
    expect(parseArgs(["up", "--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["up", "--root", "/srv/hub", "-h"])).toEqual({ kind: "help" });
  });
});

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  Supervisor,
  SupervisionFailedError,
  backoffDelayMs,
  describeExit,
  type SupervisorEvent,
} from "../src/loreserver/supervisor.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const STAY_ALIVE = join(fixtures, "stay-alive.mjs");
const EXIT_AT_ONCE = join(fixtures, "exit-at-once.mjs");

const running: Supervisor[] = [];
const temporaryDirs: string[] = [];

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nlteam-supervisor-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.stop();
  }
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a condition, or fail the test after `timeoutMs`. */
async function waitUntil(
  description: string,
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting until ${description}`);
    }
    await delay(20);
  }
}

/** True when a process id belongs to something still running. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only asks whether the process is there.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("backoffDelayMs", () => {
  it("doubles from the base delay up to the cap, and stays there", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffDelayMs)).toEqual([
      250, 500, 1000, 2000, 4000, 8000, 8000, 8000,
    ]);
  });

  it("starts at the base delay and never exceeds the cap", () => {
    expect(backoffDelayMs(1)).toBe(BACKOFF_BASE_MS);
    // A count large enough that doubling overflows to Infinity still yields
    // the cap rather than a delay that never elapses.
    expect(backoffDelayMs(2000)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(0)).toBe(BACKOFF_BASE_MS);
  });
});

describe("describeExit", () => {
  it("reports an ordinary exit code as itself", () => {
    expect(describeExit(0, null)).toBe("code 0");
    expect(describeExit(7, null)).toBe("code 7");
  });

  it("explains the number Windows reports for a process killed from outside", () => {
    // 4294967295 is 0xFFFFFFFF, which is what a terminated process leaves
    // behind on Windows rather than anything the program chose.
    const described = describeExit(4_294_967_295, null);

    expect(described).toContain("terminated from outside");
    expect(described).toContain("0xFFFFFFFF");
    // The raw value stays visible, because that is what other tools show.
    expect(described).toContain("4294967295");
  });

  it("marks a Windows fault code as abnormal without claiming to name it", () => {
    // 0xC0000005 is an access violation.
    expect(describeExit(0xc000_0005, null)).toContain("abnormal termination");
    expect(describeExit(0xc000_0005, null)).toContain("0xC0000005");
  });

  it("prefers the signal where there is one", () => {
    expect(describeExit(null, "SIGKILL")).toBe("killed by SIGKILL");
    expect(describeExit(null, null)).toBe("no exit code");
  });
});

describe("Supervisor", () => {
  /** A supervisor watching one of the fixture scripts. */
  async function supervise(
    script: string,
    logDir: string,
    events: SupervisorEvent[],
    overrides: { maximumRapidFailures?: number } = {},
  ): Promise<Supervisor> {
    const supervisor = new Supervisor({
      name: "fixture",
      command: process.execPath,
      args: [script],
      logPath: join(logDir, "logs", "fixture.log"),
      // Any run shorter than this counts as a rapid failure, so a killed
      // fixture is treated the way a crashing server would be.
      stableAfterMs: 10_000,
      maximumRapidFailures: overrides.maximumRapidFailures ?? 5,
      onEvent: (event) => events.push(event),
    });
    running.push(supervisor);
    return supervisor;
  }

  it("restarts a process that was killed, and does not after a deliberate stop", async () => {
    const dir = await temporaryDir();
    const events: SupervisorEvent[] = [];
    const supervisor = await supervise(STAY_ALIVE, dir, events);

    await supervisor.start();
    const firstPid = supervisor.pid;
    expect(firstPid).toBeGreaterThan(0);

    // Kill it the way an out-of-memory killer or an operator with the wrong
    // window would: from outside, with no warning to Team.
    process.kill(firstPid as number, "SIGKILL");

    await waitUntil(
      "the supervisor has replaced the killed process",
      () => supervisor.pid !== undefined && supervisor.pid !== firstPid,
    );
    const secondPid = supervisor.pid as number;
    expect(secondPid).not.toBe(firstPid);
    expect(isAlive(secondPid)).toBe(true);

    await supervisor.stop();

    // A deliberate stop actually takes the child down...
    expect(supervisor.pid).toBeUndefined();
    expect(supervisor.running).toBe(false);
    expect(isAlive(secondPid)).toBe(false);

    // ...and nothing takes its place. Long enough that a restart, which would
    // have been scheduled 250ms out, would have shown up by now.
    await delay(750);
    expect(supervisor.running).toBe(false);
    expect(events.filter((event) => event.kind === "started")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ kind: "exited", deliberate: true });
  }, 20_000);

  it("sends the process's output to the log file", async () => {
    const dir = await temporaryDir();
    const events: SupervisorEvent[] = [];
    const supervisor = await supervise(STAY_ALIVE, dir, events);

    await supervisor.start();
    const pid = supervisor.pid as number;
    const logPath = join(dir, "logs", "fixture.log");

    await waitUntil("the fixture's output has reached the log", () => {
      try {
        return readFileSync(logPath, "utf8").includes("running");
      } catch {
        return false;
      }
    });
    await supervisor.stop();

    const log = await readFile(logPath, "utf8");
    expect(log).toContain(`stay-alive ${pid} running`);
    // Team's own notes go in the same file, so the log reads as one story.
    expect(log).toContain(`started fixture, pid ${pid}`);
  }, 20_000);

  it("gives up after a run of rapid failures, and says how many and where to look", async () => {
    const dir = await temporaryDir();
    const events: SupervisorEvent[] = [];
    const supervisor = await supervise(EXIT_AT_ONCE, dir, events, { maximumRapidFailures: 3 });

    await supervisor.start();
    const error = await supervisor.failed;

    expect(error).toBeInstanceOf(SupervisionFailedError);
    expect(error.message).toContain("3 times in a row");
    expect(error.message).toContain(join(dir, "logs", "fixture.log"));
    expect(supervisor.running).toBe(false);

    // Two backoffs of 250ms and 500ms separated the three attempts; nothing
    // starts a fourth.
    expect(events.filter((event) => event.kind === "started")).toHaveLength(3);
    await delay(1000);
    expect(events.filter((event) => event.kind === "started")).toHaveLength(3);
  }, 20_000);

  it("reports a command that cannot be run at all rather than retrying it", async () => {
    const dir = await temporaryDir();
    const supervisor = new Supervisor({
      name: "fixture",
      command: join(dir, "no-such-executable"),
      args: [],
      logPath: join(dir, "logs", "fixture.log"),
    });
    running.push(supervisor);

    await expect(supervisor.start()).rejects.toThrow(/could not start fixture/);
    expect(supervisor.running).toBe(false);
  }, 20_000);

  it("can be stopped when nothing was ever started", async () => {
    const dir = await temporaryDir();
    const supervisor = new Supervisor({
      name: "fixture",
      command: process.execPath,
      args: [STAY_ALIVE],
      logPath: join(dir, "logs", "fixture.log"),
    });

    await expect(supervisor.stop()).resolves.toBeUndefined();
  });
});

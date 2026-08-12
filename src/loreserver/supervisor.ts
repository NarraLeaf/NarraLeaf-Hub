/**
 * Keeping a child process running.
 *
 * The rules are the ones any long-lived server wants: an exit nobody asked for
 * is followed by a restart, restarts slow down so that a process failing on
 * every launch does not spin, and a process that keeps failing immediately is
 * eventually left alone rather than restarted forever in a loop nothing is
 * watching.
 *
 * Nothing here knows what loreserver is. It takes a command, a log file and
 * some numbers, which is also what makes it testable without one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** The first restart delay, in milliseconds. */
export const BACKOFF_BASE_MS = 250;
/** The longest a restart is ever delayed, in milliseconds. */
export const BACKOFF_CAP_MS = 8_000;

/**
 * How long to wait before the nth consecutive restart.
 *
 * Doubling from a quarter of a second up to eight seconds: quick enough that a
 * process killed by accident is back before anyone notices, slow enough that
 * one which cannot start does not consume a core trying.
 */
export function backoffDelayMs(consecutiveFailures: number): number {
  const doublings = Math.max(0, consecutiveFailures - 1);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** doublings);
}

/** Something the supervisor did, in the order it did it. */
export type SupervisorEvent =
  | { readonly kind: "started"; readonly pid: number; readonly attempt: number }
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      /** True when the exit followed a call to `stop`. */
      readonly deliberate: boolean;
    }
  | {
      readonly kind: "restarting";
      readonly delayMs: number;
      readonly consecutiveFailures: number;
    }
  | { readonly kind: "gave-up"; readonly error: Error };

/** Raised when a process failed so often, so quickly, that it was abandoned. */
export class SupervisionFailedError extends Error {
  constructor(
    readonly processName: string,
    readonly failures: number,
    readonly logPath: string,
    options?: { cause?: unknown },
  ) {
    super(
      `${processName} failed ${failures} times in a row without staying up, so Hub stopped ` +
        `restarting it. Its output is in ${logPath}.`,
      options,
    );
    this.name = "SupervisionFailedError";
  }
}

export interface SupervisorOptions {
  /** How the process is named in messages, for example `loreserver`. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** File the process's stdout and stderr are appended to. */
  readonly logPath: string;
  readonly cwd?: string;
  /**
   * A run lasting at least this long is taken as a success, and clears the
   * count of consecutive failures. Shorter runs are what "failing rapidly"
   * means.
   */
  readonly stableAfterMs?: number;
  /** How many rapid failures in a row are tolerated before giving up. */
  readonly maximumRapidFailures?: number;
  /** How long a stopped process is given to exit before it is killed outright. */
  readonly terminationGraceMs?: number;
  readonly onEvent?: (event: SupervisorEvent) => void;
}

/** Whatever ended a child, so that one path can handle both ways it can. */
type ChildOutcome =
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "error"; readonly error: Error };

export class Supervisor {
  readonly #options: SupervisorOptions;
  readonly #stableAfterMs: number;
  readonly #maximumRapidFailures: number;
  readonly #terminationGraceMs: number;

  /**
   * Resolves with the error that ended supervision, if it ever ends. A caller
   * that only wants to know it is still running can leave this promise
   * pending; it resolves rather than rejects, so nothing has to handle it.
   */
  readonly failed: Promise<Error>;
  readonly #reportFailure: (error: Error) => void;

  #child: ChildProcess | undefined;
  #childStartedAt = 0;
  #log: WriteStream | undefined;
  /** True from the moment a stop is asked for, or supervision is abandoned. */
  #stopping = false;
  #consecutiveFailures = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #resolveDeliberateExit: (() => void) | undefined;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#stableAfterMs = options.stableAfterMs ?? 10_000;
    this.#maximumRapidFailures = options.maximumRapidFailures ?? 5;
    this.#terminationGraceMs = options.terminationGraceMs ?? 5_000;

    let report: (error: Error) => void = () => {};
    this.failed = new Promise<Error>((resolve) => {
      report = resolve;
    });
    this.#reportFailure = report;
  }

  /** The process id of the running child, or undefined when none is running. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** True while a child is running. */
  get running(): boolean {
    return this.#child !== undefined;
  }

  /**
   * Start the process and begin supervising it.
   *
   * Rejects if the very first launch fails, because a command that cannot be
   * run at all is a mistake to report rather than something to retry.
   */
  async start(): Promise<void> {
    if (this.#child !== undefined) {
      throw new Error(`${this.#options.name} is already running`);
    }
    this.#stopping = false;
    this.#consecutiveFailures = 0;

    await mkdir(dirname(this.#options.logPath), { recursive: true });
    this.#log ??= createWriteStream(this.#options.logPath, { flags: "a" });

    await this.#launch(1);
  }

  /**
   * Stop the process and do not restart it.
   *
   * Returns once the child has actually gone, so that a caller which is about
   * to exit does not leave one behind. Safe to call when nothing is running.
   */
  async stop(): Promise<void> {
    this.#stopping = true;

    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }

    const child = this.#child;
    if (child !== undefined) {
      const exited = new Promise<void>((resolve) => {
        this.#resolveDeliberateExit = resolve;
      });
      this.#note(`stopping ${this.#options.name}`);
      child.kill();
      // A process that ignores the polite signal, or is wedged, still has to
      // go: a stop that returns while the child lives would strand it.
      const force = setTimeout(() => {
        child.kill("SIGKILL");
      }, this.#terminationGraceMs);
      try {
        await exited;
      } finally {
        clearTimeout(force);
        this.#resolveDeliberateExit = undefined;
      }
    }

    await this.#closeLog();
  }

  /** Spawn one child and, once it is running, watch it. */
  async #launch(attempt: number): Promise<void> {
    const { command, args, cwd } = this.#options;
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(cwd === undefined ? {} : { cwd }),
    });
    this.#child = child;

    if (this.#log !== undefined) {
      // `end: false` keeps the log open across restarts; each child's streams
      // finish when it exits, and closing the log with them would leave the
      // next child writing to a closed stream.
      child.stdout?.pipe(this.#log, { end: false });
      child.stderr?.pipe(this.#log, { end: false });
    }

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        // Left attached after it has fired or been overtaken: a ChildProcess
        // with no error listener turns a later error into an uncaught
        // exception, and rejecting a settled promise does nothing.
        child.once("error", reject);
      });
    } catch (error) {
      this.#child = undefined;
      throw new Error(
        `could not start ${this.#options.name} (${command}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    this.#childStartedAt = Date.now();
    this.#note(`started ${this.#options.name}, pid ${child.pid ?? 0}`);
    this.#watch(child);
    this.#emit({ kind: "started", pid: child.pid ?? 0, attempt });
  }

  /** Attach the handlers that decide what happens when a child ends. */
  #watch(child: ChildProcess): void {
    let ended = false;
    const end = (outcome: ChildOutcome): void => {
      if (ended) {
        return;
      }
      ended = true;
      this.#afterChild(child, outcome);
    };

    child.on("exit", (code, signal) => {
      end({ kind: "exit", code, signal });
    });
    child.on("error", (error) => {
      this.#note(`${this.#options.name} process error: ${error.message}`);
      end({ kind: "error", error });
    });
  }

  /** Decide whether to restart, give up, or let a deliberate stop finish. */
  #afterChild(child: ChildProcess, outcome: ChildOutcome): void {
    if (this.#child !== child) {
      return;
    }
    this.#child = undefined;

    const code = outcome.kind === "exit" ? outcome.code : null;
    const signal = outcome.kind === "exit" ? outcome.signal : null;

    if (this.#stopping) {
      this.#emit({ kind: "exited", code, signal, deliberate: true });
      this.#resolveDeliberateExit?.();
      return;
    }

    this.#emit({ kind: "exited", code, signal, deliberate: false });
    this.#note(`${this.#options.name} exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);

    if (Date.now() - this.#childStartedAt >= this.#stableAfterMs) {
      this.#consecutiveFailures = 0;
    }
    this.#consecutiveFailures += 1;

    if (this.#consecutiveFailures >= this.#maximumRapidFailures) {
      this.#giveUp(outcome.kind === "error" ? { cause: outcome.error } : undefined);
      return;
    }

    const delayMs = backoffDelayMs(this.#consecutiveFailures);
    this.#emit({
      kind: "restarting",
      delayMs,
      consecutiveFailures: this.#consecutiveFailures,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#stopping) {
        return;
      }
      this.#launch(this.#consecutiveFailures + 1).catch((error: unknown) => {
        this.#giveUp({ cause: error });
      });
    }, delayMs);
  }

  /** Abandon supervision and tell whoever is waiting on `failed`. */
  #giveUp(options?: { cause?: unknown }): void {
    this.#stopping = true;
    const error = new SupervisionFailedError(
      this.#options.name,
      this.#consecutiveFailures,
      this.#options.logPath,
      options,
    );
    this.#note(error.message);
    this.#emit({ kind: "gave-up", error });
    this.#reportFailure(error);
    void this.#closeLog();
  }

  #emit(event: SupervisorEvent): void {
    this.#options.onEvent?.(event);
  }

  /** Write a line of Hub's own into the log, so it reads in order. */
  #note(text: string): void {
    this.#log?.write(`[${new Date().toISOString()}] hub: ${text}\n`);
  }

  async #closeLog(): Promise<void> {
    const log = this.#log;
    if (log === undefined) {
      return;
    }
    this.#log = undefined;
    await new Promise<void>((resolve) => {
      log.end(resolve);
    });
  }
}

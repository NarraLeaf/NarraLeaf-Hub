/**
 * Whether a loreserver is answering.
 *
 * loreserver's HTTP listener exposes `/health_check`, which answers 200 once
 * the server is up. That is the only signal that a spawned process has become
 * a working server: the process exists long before it is listening.
 */

/** Where the health check lives on a loreserver's HTTP port. */
export function healthCheckUrl(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}/health_check`;
}

/** Raised when a loreserver did not answer its health check in time. */
export class HealthTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
    readonly lastFailure: string,
  ) {
    super(
      `loreserver did not answer ${url} within ${Math.round(timeoutMs / 1000)}s. ` +
        `Last attempt: ${lastFailure}.`,
    );
    this.name = "HealthTimeoutError";
  }
}

/** How long a single probe waits before it is abandoned. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Ask a loreserver once whether it is healthy.
 *
 * Answers false rather than raising for a refused connection or a slow reply,
 * because during startup both are ordinary. Exported for callers that want to
 * check a server they did not start.
 */
export async function checkHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(healthCheckUrl(port), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // The body is not read anywhere, and an unread body holds the socket open
    // until the garbage collector gets to it. Cancelling releases it now.
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Options for waiting on a server to come up. */
export interface WaitForHealthOptions {
  /** Give up after this long. */
  readonly timeoutMs?: number;
  /** Wait this long between attempts. */
  readonly intervalMs?: number;
  /** Abandon the wait early, for example when the operator interrupts. */
  readonly signal?: AbortSignal;
  /**
   * Consulted between attempts. Returning a string abandons the wait with that
   * reason — it is how a supervised process that has died stops the wait
   * instead of letting it run to the timeout.
   */
  readonly abandonReason?: () => string | undefined;
}

/**
 * Poll the health check until it answers, or the timeout expires.
 *
 * Returns how long the wait took, in milliseconds.
 */
export async function waitForHealth(
  port: number,
  options: WaitForHealthOptions = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();

  let lastFailure = "no reply";
  for (;;) {
    options.signal?.throwIfAborted();

    const reason = options.abandonReason?.();
    if (reason !== undefined) {
      throw new HealthTimeoutError(healthCheckUrl(port), Date.now() - startedAt, reason);
    }

    if (await checkHealth(port)) {
      return Date.now() - startedAt;
    }
    lastFailure = "no reply from the health check port";

    if (Date.now() - startedAt >= timeoutMs) {
      throw new HealthTimeoutError(healthCheckUrl(port), timeoutMs, lastFailure);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

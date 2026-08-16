/**
 * Reading every project's repository, without anything waiting for it.
 *
 * The database answers instantly and a repository does not: a clone is network
 * work, and the first read of a project Team has never seen is the slowest one
 * it will ever do. So the view is gathered from the database and drawn, and
 * this fills the repository parts in afterwards, telling whoever is drawing
 * that there is something new to draw.
 *
 * Until a project has been read its history and its file are simply absent,
 * which is already what the interface renders as unknown. That is the whole of
 * what a slow or unreachable loreserver costs: freshness. Nothing waits, and
 * nothing on screen turns into an error.
 *
 * One project at a time, on purpose. Two clones at once would compete for the
 * same bandwidth to say the same thing later, and the point of this is that
 * nobody is waiting for any particular one of them.
 */
import type { DatabaseSync } from "node:sqlite";

import { audienceHosts, authUrl, dataRemoteUrl, type IdentityConfig } from "../identity/config.js";
import { KeyStore } from "../identity/keys.js";
import { identityLayout } from "../identity/layout.js";
import { mintToken } from "../identity/tokens.js";
import { findUserById } from "../identity/users.js";
import { readAuthority } from "../tls/authority.js";
import { listProjects, PROJECT_PERMISSIONS, resourceIdOf } from "./registry.js";
import { readProject, type ProjectReading } from "./read.js";

/** A failure in words, whatever it arrived as. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How long between passes over every project. */
const DEFAULT_INTERVAL_MS = 60_000;

export interface ProjectReadingsOptions {
  readonly root: string;
  readonly database: DatabaseSync;
  readonly config: IdentityConfig;
  /** Called each time a project's reading changes what is on screen. */
  readonly onChange?: () => void;
  readonly intervalMs?: number;
}

/**
 * What one project's repository last said.
 *
 * The map is only ever added to and replaced in whole entries, so a reader
 * taking a view of it never sees half of a project's reading.
 */
export class ProjectReadings {
  private readonly readings = new Map<string, ProjectReading>();
  private keys: KeyStore | undefined;
  private trusted = false;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private wanted = false;
  private stopped = false;

  constructor(private readonly options: ProjectReadingsOptions) {}

  /** What Team last read about one project, or undefined if it has not. */
  get(projectId: string): ProjectReading | undefined {
    return this.readings.get(projectId);
  }

  /** Begin reading, and keep reading on an interval until stopped. */
  start(): void {
    if (this.stopped) {
      return;
    }
    this.request();
    this.timer = setInterval(() => this.request(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    // Nothing should be kept alive by this: when the screen is gone, so is the
    // reason to read anything.
    this.timer.unref();
  }

  /**
   * Ask for a pass now.
   *
   * A pass already under way is not interrupted and a second one is not
   * started beside it; one more is run after it instead, so that pressing
   * refresh repeatedly costs one extra pass rather than one each.
   */
  request(): void {
    if (this.stopped) {
      return;
    }
    this.wanted = true;
    if (!this.running) {
      void this.drain();
    }
  }

  /** Stop reading. A pass under way is left to finish on its own. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.wanted && !this.stopped) {
        this.wanted = false;
        await this.pass();
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Let the version control library trust this Team server's own authority.
   *
   * A loreserver told to demand a token sends its clients to Team's https
   * endpoint to exchange one, and Team is one of those clients. Lore's TLS is
   * rustls, which verifies that endpoint's certificate against its own trust
   * store — and a Team server's authority is one it generated for itself, which no
   * store on earth holds. Without this the exchange fails with "failed to
   * connect to auth endpoint: transport error" and every clone that follows is
   * refused with "Not authorized to access repository", which reads as a
   * permission problem and is not one.
   *
   * `SSL_CERT_FILE` is the channel because it is the one rustls-native-certs
   * offers, and it is what `up` already hands loreserver for the same reason.
   * It replaces the trust store rather than adding to it, which is exactly
   * right here: everything this library talks to is this Team server. Node's own
   * outbound TLS — the release downloads — does not read it. An operator who
   * set it themselves is left alone.
   */
  private async trustOwnAuthority(): Promise<void> {
    if (this.trusted) {
      return;
    }
    if (process.env["SSL_CERT_FILE"] !== undefined && process.env["SSL_CERT_FILE"] !== "") {
      this.trusted = true;
      return;
    }
    try {
      const authority = await readAuthority(this.options.root);
      process.env["SSL_CERT_FILE"] = authority.layout.caCertPath;
      this.trusted = true;
    } catch {
      // A Team server that has not been brought up has no authority yet. Left to be
      // tried again on the next pass rather than latched as done.
    }
  }

  private async pass(): Promise<void> {
    const { root, database, config } = this.options;
    const remote = dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort);

    await this.trustOwnAuthority();

    // Once per pass rather than once per project, and re-read each pass so
    // that a key rotated in another terminal is picked up without this being
    // restarted. A Team server that has not been brought up has no keys directory at
    // all, and that is a reason to read without a token rather than to stop.
    this.keys = await KeyStore.open(identityLayout(root).keysDir).catch(() => undefined);

    for (const project of listProjects(database)) {
      if (this.stopped) {
        return;
      }
      try {
        const token = this.mint(project.id, project.createdBy);
        const reading = await readProject({
          root,
          projectId: project.id,
          projectName: project.name,
          remote,
          // The https endpoint, and there is no alternative: Lore's client
          // registers handlers for `https` and `ucs-auth` only, and answers a
          // plaintext one with "no authentication implementation registered
          // for scheme 'http'". Reaching it is what {@link trustOwnAuthority}
          // is for.
          ...(token === undefined ? {} : { token, authUrl: authUrl(config) }),
        });
        this.readings.set(project.id, reading);
      } catch (error) {
        // readProject answers rather than raising, so anything reaching here is
        // Team's own doing — minting a token, or something worse. It is put
        // where every other thing Team could not read goes, which is the screen,
        // rather than into a log nobody has open. The pass carries on: one
        // project that cannot be read must not cost the others theirs.
        this.readings.set(project.id, {
          history: {},
          file: { readable: false, reason: `Team could not read this project: ${describe(error)}` },
          cloned: false,
        });
      }
      this.options.onChange?.();
    }
  }

  /**
   * A token for reading one project, or undefined if none can be made.
   *
   * Minted for the account that owns the project and named for that project
   * alone, which is the same shape a Studio installation presents. Undefined
   * where the owner is gone or disabled — a loreserver that demands nobody's
   * identity accepts the read anyway, and one that does refuses it with a
   * sentence that says so, which is better than Team reading as somebody who
   * has been shut out.
   */
  private mint(projectId: string, ownerId: string): string | undefined {
    const keys = this.keys;
    if (keys === undefined) {
      return undefined;
    }
    try {
      const owner = findUserById(this.options.database, ownerId);
      if (owner === undefined) {
        return undefined;
      }
      return mintToken(owner, keys.signingKey, this.options.config, {
        // The short lifetime, because this one is presented on the data
        // connection and Team is not asked about it again.
        purpose: "repository",
        resources: [{ resource_id: resourceIdOf(projectId), permission: [...PROJECT_PERMISSIONS] }],
      }).token;
    } catch {
      return undefined;
    }
  }
}

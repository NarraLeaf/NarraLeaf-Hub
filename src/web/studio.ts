/**
 * The API a Studio installation talks to.
 *
 * Studio is handed one address and a token, and everything else has to be
 * behind them. The discovery document turns the address into a server; this
 * turns the token into a list of projects and a way to make another. Without
 * it an author has to be told a repository id by hand, which is the one thing
 * the address was supposed to replace.
 *
 * It is served on the same HTTP/1.1 listener as the discovery document, and
 * **before the switch that turns the web interface on**: the interface is a
 * page for an operator and is off by default, while this is how every Studio
 * installation finds its work. One listener also means one certificate, and
 * therefore one decision to trust — the reason set out in ./router.ts.
 *
 * Authentication is the token itself, presented as a bearer, and checked by
 * exactly what the authorization service checks it with. There is no session
 * and nothing to sign out of: the token is what a person was handed, and its
 * lifetime is the whole of how long this works.
 *
 * What it does not do is decide who may reach what. Every account of this
 * server reaches every project on it, so the list is the same list for
 * everybody — see src/projects/registry.ts. That is the whole of the
 * authorization here: none of the reads below filters, ranks or hides anything
 * by who asked.
 *
 * The routes
 * ----------
 *
 *     GET  /api/studio/v1/projects              every project on this server
 *     POST /api/studio/v1/projects              make another
 *     GET  /api/studio/v1/projects/:id          one of them, and what is in it
 *     GET  /api/studio/v1/projects/:id/history  a page of its revisions
 *     GET  /api/studio/v1/members               every account, as a name
 *
 * What is absent and what is nought
 * ---------------------------------
 * Everything that comes out of a repository is optional, and a field Team has
 * not read is left out rather than sent as zero. A project cloned for the first
 * time may be minutes away from having a history to report, and a row saying
 * nought revisions is a row saying nobody has ever worked on it. Absent is the
 * only honest answer while the read is still running, and it is the same answer
 * a project written by a newer Studio gets — which is what keeps this server
 * from having to be upgraded in step with the one it serves.
 *
 * Nothing here starts a repository read or waits on one. Whatever the reader
 * has landed so far is what is served.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { audienceHosts, dataRemoteUrl, type IdentityConfig } from "../identity/config.js";
import { bearerToken, describeRefusal, identifyToken } from "../identity/bearer.js";
import type { KeyStore } from "../identity/keys.js";
import { storedTokenLifetimes } from "../identity/settings.js";
import { mintToken } from "../identity/tokens.js";
import type { UserRecord } from "../identity/users.js";
import { findUserById, listUsers } from "../identity/users.js";
import type { RevisionPage } from "../projects/read.js";
import {
  createProject,
  findProject,
  forgetProject,
  listProjects,
  newProjectId,
  type ProjectRecord,
} from "../projects/registry.js";
import { loreserverUrl, repositoryCreate } from "../projects/repository.js";
import { NOT_READ_YET } from "../tui/teamview.js";
import type { ProjectFileView, RevisionView } from "../tui/teamview.js";
import { isOperator } from "./api.js";

/** Where the routes live. Versioned, because a client older than the server is ordinary. */
const PREFIX = "/api/studio/v1";

/** The one collection there is. */
const PROJECTS = `${PREFIX}/projects`;

/** Every account of this server, as names rather than as accounts. */
const MEMBERS = `${PREFIX}/members`;

/** What hangs off one project. */
const HISTORY = "history";

/** How much of a request body is read before it is refused as nonsense. */
const MAXIMUM_BODY_BYTES = 4 * 1024;

/** How many revisions a page of history holds when it is not asked for a number. */
const DEFAULT_HISTORY_LIMIT = 20;

/**
 * The most revisions one page may hold.
 *
 * Each one costs a read of its metadata, so a page is a bounded amount of work
 * rather than however much a client asked for. Somebody wanting the whole of a
 * long history pages through it, which is what the cursor is for.
 */
const MAXIMUM_HISTORY_LIMIT = 100;

/**
 * What Team has read out of the repositories, and a way to read one page more.
 *
 * Deliberately optional, and deliberately only a lookup. Answering a request
 * must not start a repository read, wait for one, or be able to: a clone is the
 * slowest thing this server does, and a list of projects that stopped on a
 * loreserver which was not answering would be a list nobody could open Studio
 * without. Whatever has landed is served; the rest is absent.
 */
export interface StudioReadings {
  /** What Team last read about one project, or undefined if it has not. */
  get(projectId: string): { readonly history: RevisionView; readonly file: ProjectFileView } | undefined;
  /**
   * One page of a project's revisions, read on demand.
   *
   * Optional because it is what decides whether this build says it serves a
   * history at all — see {@link studioCapabilities}. Undefined from the call
   * means Team has no checkout of that project to read yet.
   */
  readonly revisions?: (
    projectId: string,
    page: { readonly limit: number; readonly before?: string },
  ) => Promise<RevisionPage | undefined>;
}

/** Everything this API needs that is not in the request. */
export interface StudioApiOptions {
  readonly database: DatabaseSync;
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
  /** The port loreserver serves gRPC on, for creating a repository. */
  readonly dataPort: number;
  /** What the repositories last said. Absent on a server that reads none. */
  readonly readings?: StudioReadings;
  /** Somewhere to say what happened, in the same place `up` says everything else. */
  readonly log?: (line: string) => void;
}

/**
 * The names Studio matches literally to know what this server answers.
 *
 * Words rather than a version number, because they are added one at a time and
 * a client wants to know about each on its own. `password-sign-in` is named
 * here and not emitted by this build: it belongs to a route that does not
 * exist yet, and the list says what is served rather than what is planned.
 */
export type StudioCapability =
  | "projects"
  | "project-detail"
  | "members"
  | "project-history"
  | "password-sign-in";

/**
 * What this build serves, worked out from what it was given.
 *
 * Read from the options rather than written down, so that the discovery
 * document cannot come to say something this file does not do. The three
 * unconditional ones are unconditional in {@link serveStudioApi} too; the
 * history is there only where there is something to read a history out of.
 */
export function studioCapabilities(options: StudioApiOptions): StudioCapability[] {
  const capabilities: StudioCapability[] = ["projects", "project-detail", "members"];
  if (options.readings?.revisions !== undefined) {
    capabilities.push("project-history");
  }
  return capabilities;
}

/** One project, as a Studio installation reads it. */
interface ProjectBody {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Who made it, by username; absent for an account that has been deleted. */
  readonly createdBy?: string;
  readonly createdAt: number;
  /**
   * The remote to clone, which is the address Studio would otherwise be told.
   *
   * **The project's name is on the end, and it has to be.** A client is given
   * `lore://host:port/<name>` and refuses one without the name — measured: the
   * clone page marks an origin-only address invalid and will not go on. What
   * the client stores afterwards is only the origin, which is why it is easy to
   * think the name is decoration.
   */
  readonly remote: string;
  /**
   * What the repository says about itself, absent until Team has read it.
   *
   * Absent rather than empty, and never zeroed. The first read of a project is
   * a clone and the slowest thing this server does, and a project that has been
   * worked on for months must not read as one nobody has touched while that
   * clone is still running.
   */
  readonly history?: RevisionView;
}

/**
 * One account, as a name beside a piece of work rather than as an account.
 *
 * What is here is what somebody needs in order to know whose revision they are
 * looking at. What is not here is an operator's business: when an account's
 * tokens were last refused, what groups it is in beyond the one label below,
 * and anything else the management plane keeps.
 *
 * `operator` is that label, and it is a label. It says this account may open
 * the operator's page and administer this server. It is not a permission over
 * any project: every account of this server reaches every project on it.
 */
interface MemberBody {
  readonly username: string;
  readonly displayName: string;
  /**
   * The address, where the account has one.
   *
   * Included on purpose. It is already on every revision this person authored,
   * so within this server it is not a secret, and a member list that could not
   * be matched against a history would not be much of a member list. What is
   * done with it is Studio's decision, which is to show it to nobody by
   * default.
   */
  readonly email?: string;
  readonly operator: boolean;
  /**
   * Whether the account may still sign in.
   *
   * A disabled account is listed rather than dropped. Somebody who wrote half
   * of a project's history and then left is still the person that history
   * names, and a list they had fallen out of would leave those revisions signed
   * by a stranger.
   */
  readonly disabled: boolean;
  readonly serviceAccount: boolean;
  readonly createdAt: number;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

/**
 * Say no, in the shape everything else here answers in.
 *
 * One sentence and nothing else. A client that cannot act on the difference
 * between two refusals is a client that will print whichever it got, so the
 * sentence is the whole of the answer.
 */
function refuse(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

function projectBody(options: StudioApiOptions, project: ProjectRecord): ProjectBody {
  const { database, config } = options;
  const maker = findUserById(database, project.createdBy);
  // Whatever the reader has landed, and nothing is asked of it here. A project
  // it has not reached has no history, which is left out rather than filled in.
  const history = options.readings?.get(project.id)?.history;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    ...(maker === undefined ? {} : { createdBy: maker.username }),
    createdAt: project.createdAt,
    // Built from what this server was started with rather than stored, for the
    // same reason the discovery document is: the address a project is reached
    // at is a fact about the deployment, not about the project.
    remote: `${dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort)}/${project.name}`,
    ...(history === undefined ? {} : { history }),
  };
}

function memberBody(user: UserRecord): MemberBody {
  return {
    username: user.username,
    displayName: user.displayName,
    ...(user.email === undefined ? {} : { email: user.email }),
    // The one group question this API asks, asked where the interface asks it,
    // so that the label and the door cannot come to disagree.
    operator: isOperator(user.groups),
    disabled: user.disabledAt !== undefined,
    serviceAccount: user.isServiceAccount,
    createdAt: user.createdAt,
  };
}

/** Read a JSON body, or say what was wrong with it. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAXIMUM_BODY_BYTES) {
      return "that request body is larger than anything this API takes";
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    return "that request needs a JSON body";
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "that request body is not a JSON object";
    }
    return parsed as Record<string, unknown>;
  } catch {
    return "that request body is not JSON";
  }
}

function text(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Whoever presented the token, or undefined once the refusal has been sent.
 *
 * The same check the authorization service makes, so a token this API accepts
 * is one that reaches a repository and a token it refuses is one that would
 * have failed later anyway.
 */
function caller(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): UserRecord | undefined {
  const authorization = request.headers["authorization"];
  const token = bearerToken(Array.isArray(authorization) ? authorization[0] : authorization);
  const identified = identifyToken(options.database, options.keys, options.config, token);
  if (identified.kind === "refused") {
    refuse(response, 401, describeRefusal(identified.reason));
    return undefined;
  }
  return identified.user;
}

/**
 * Answer a request if it is one of ours, and say whether it was.
 *
 * Returns false for everything outside this API's prefix, so the router goes on
 * to the interface and the pages without this having to know they exist.
 *
 * Everything **inside** the prefix is answered here, including the addresses
 * there is nothing at. Falling through with one of those would hand it to the
 * arm that serves the operator's page, and on a server with that page switched
 * off the answer to a mistyped API address would be a sentence about a web
 * interface — which tells whoever typed it nothing about what they typed.
 */
export function serveStudioApi(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) {
    return false;
  }

  if (path === PROJECTS) {
    if (request.method === "GET") {
      void answerProjectList(options, request, response);
      return true;
    }
    if (request.method === "POST") {
      void answerProjectCreate(options, request, response);
      return true;
    }
    onlyMethods(response, "GET, POST", "GET and POST");
    return true;
  }

  if (path === MEMBERS) {
    if (request.method !== "GET") {
      onlyMethods(response, "GET", "GET");
      return true;
    }
    answerMembers(options, request, response);
    return true;
  }

  const under = beneathProjects(path);
  if (under !== undefined) {
    if (request.method !== "GET") {
      onlyMethods(response, "GET", "GET");
      return true;
    }
    if (under.rest === undefined) {
      answerProject(options, request, response, under.reference);
      return true;
    }
    if (under.rest === HISTORY) {
      void answerProjectHistory(options, request, response, under.reference);
      return true;
    }
  }

  refuse(response, 404, "this server has nothing at that address.");
  return true;
}

/**
 * Take a path apart into the project it names and whatever hangs off it.
 *
 * Undefined for anything that is not under the collection, so the router goes
 * on to the pages rather than this claiming an address it has no answer for.
 * The separator is a real one: the URL parser leaves an escaped slash escaped,
 * so a project reference cannot be made to look like two segments.
 */
function beneathProjects(path: string): { reference: string; rest?: string } | undefined {
  if (!path.startsWith(`${PROJECTS}/`)) {
    return undefined;
  }
  const [first, second, ...more] = path.slice(PROJECTS.length + 1).split("/");
  if (first === undefined || first === "" || more.length > 0) {
    return undefined;
  }
  const reference = decodeSegment(first);
  if (reference === undefined) {
    return undefined;
  }
  return second === undefined || second === "" ? { reference } : { reference, rest: second };
}

/** One path segment as it was written, or undefined if it was written wrongly. */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Say which methods an address takes, in the header and in the sentence. */
function onlyMethods(response: ServerResponse, allow: string, spoken: string): void {
  response.writeHead(405, { allow, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: `that address takes ${spoken}` }));
}

function answerProjectList(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  const projects = listProjects(options.database).map((project) =>
    projectBody(options, project),
  );
  options.log?.(`studio: ${user.username} listed ${projects.length} project(s)`);
  sendJson(response, 200, { projects });
}

/**
 * One project, and what is in it.
 *
 * The project is the same body a row of the list is, history and all, so
 * nothing here is a second account of what a project is. What this adds is the
 * project file — the title, the stage, how many scenes and assets — which is
 * read out of the repository and is therefore the part that may be absent.
 *
 * A file Team could not make sense of is `readable: false` and a sentence
 * saying why, never a refusal. Most often it was written by a newer Studio,
 * and the project around it is still true.
 */
function answerProject(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  reference: string,
): void {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  // By id or by name, because both are things a client has in front of it: the
  // id every row carries, and the name the remote address ends with.
  const project = findProject(options.database, reference);
  if (project === undefined) {
    refuse(response, 404, `there is no project called ${reference}.`);
    return;
  }
  const read = options.readings?.get(project.id) ?? NOT_READ_YET;
  options.log?.(`studio: ${user.username} opened ${project.name} (${project.id})`);
  sendJson(response, 200, { project: projectBody(options, project), file: read.file });
}

/**
 * Every account of this server, so that a name on a revision is a person.
 *
 * Every account, including the disabled ones. This is not a list of who may do
 * something — everybody may, which is the rule the rest of this server is built
 * on — it is the list a history is read against, and somebody who left is still
 * the author of what they wrote.
 */
function answerMembers(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  const members = listUsers(options.database).map((account) => memberBody(account));
  options.log?.(`studio: ${user.username} listed ${members.length} member(s)`);
  sendJson(response, 200, { members });
}

/**
 * A page of one project's revisions.
 *
 * Read when it is asked for and never on the interval that refreshes the rest:
 * a history is read by one person looking at one project, and reading every
 * page of every project once a minute would be work nobody asked for.
 *
 * A project Team has no checkout of yet answers with `revisions` absent, for
 * the same reason a row of the list has no history: an empty page reads as a
 * project with no revisions, which is a different and untrue thing.
 */
async function answerProjectHistory(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  reference: string,
): Promise<void> {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  const project = findProject(options.database, reference);
  if (project === undefined) {
    refuse(response, 404, `there is no project called ${reference}.`);
    return;
  }
  const read = options.readings?.revisions;
  if (read === undefined) {
    // A build serving no history says so in its capabilities, so a client that
    // read them does not ask. One that asked anyway is answered the same way a
    // project nobody has read is: absent, rather than a refusal it can do
    // nothing about.
    sendJson(response, 200, { more: false });
    return;
  }

  const query = new URL(request.url ?? "/", "http://team.invalid").searchParams;
  const limit = pageLimit(query.get("limit"));
  const before = query.get("before") ?? undefined;

  const page = await read(project.id, {
    limit,
    ...(before === undefined || before === "" ? {} : { before }),
  });
  if (page === undefined) {
    sendJson(response, 200, { more: false });
    return;
  }
  options.log?.(
    `studio: ${user.username} read ${page.revisions.length} revision(s) of ${project.name}`,
  );
  sendJson(response, 200, { revisions: page.revisions, more: page.more });
}

/**
 * How many revisions to read, from what was asked for.
 *
 * Anything that is not a number this can act on becomes the default rather
 * than a refusal: a client that sent nonsense wanted a page of history, and a
 * page of history is a better answer than a sentence about its query string.
 */
function pageLimit(asked: string | null): number {
  const wanted = Number(asked);
  if (asked === null || asked === "" || !Number.isInteger(wanted) || wanted < 1) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(wanted, MAXIMUM_HISTORY_LIMIT);
}

async function answerProjectCreate(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const user = caller(options, request, response);
  if (user === undefined) {
    return;
  }
  const body = await readJson(request);
  if (typeof body === "string") {
    refuse(response, 400, body);
    return;
  }
  const name = text(body, "name");
  if (name === undefined) {
    refuse(response, 400, "a project needs a name");
    return;
  }
  const description = text(body, "description") ?? "";

  // The row is written before loreserver is asked, and removed again if it
  // refuses. That order matters: loreserver announces the new repository back
  // to Team while the create call is still open, and a server that had not
  // recorded the project yet would have nothing to say about it.
  const config = { ...options.config, ...storedTokenLifetimes(options.database) };
  const minted = mintToken(user, options.keys.signingKey, config, { purpose: "repository" });
  let project: ProjectRecord;
  try {
    project = createProject(options.database, {
      id: newProjectId(),
      name,
      description,
      createdBy: user.id,
    });
  } catch (error) {
    refuse(response, 409, error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    await repositoryCreate({
      url: loreserverUrl(options.dataPort),
      token: minted.token,
      id: project.id,
      name: project.name,
      description: project.description,
    });
  } catch (error) {
    forgetProject(options.database, project.id);
    options.log?.(
      `studio: ${user.username} could not create ${name}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    // 502 rather than 500: Team did its part, and the thing that refused is the
    // other server. A client that says so is one whose operator looks in the
    // right log.
    refuse(response, 502, error instanceof Error ? error.message : String(error));
    return;
  }

  options.log?.(`studio: ${user.username} created ${project.name} (${project.id})`);
  // No history on it, and that is right: the repository was made a moment ago
  // and nothing has been read out of it. Absent says so; nought would say
  // somebody had already emptied it.
  sendJson(response, 201, { project: projectBody(options, project) });
}

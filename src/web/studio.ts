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
 * everybody — see src/projects/registry.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { audienceHosts, dataRemoteUrl, type IdentityConfig } from "../identity/config.js";
import { bearerToken, describeRefusal, identifyToken } from "../identity/bearer.js";
import type { KeyStore } from "../identity/keys.js";
import { storedTokenLifetimes } from "../identity/settings.js";
import { mintToken } from "../identity/tokens.js";
import type { UserRecord } from "../identity/users.js";
import { findUserById } from "../identity/users.js";
import {
  createProject,
  forgetProject,
  listProjects,
  newProjectId,
  type ProjectRecord,
} from "../projects/registry.js";
import { loreserverUrl, repositoryCreate } from "../projects/repository.js";

/** Where the routes live. Versioned, because a client older than the server is ordinary. */
const PREFIX = "/api/studio/v1";

/** The one collection there is. */
const PROJECTS = `${PREFIX}/projects`;

/** How much of a request body is read before it is refused as nonsense. */
const MAXIMUM_BODY_BYTES = 4 * 1024;

/** Everything this API needs that is not in the request. */
export interface StudioApiOptions {
  readonly database: DatabaseSync;
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
  /** The port loreserver serves gRPC on, for creating a repository. */
  readonly dataPort: number;
  /** Somewhere to say what happened, in the same place `up` says everything else. */
  readonly log?: (line: string) => void;
}

/** One project, as a Studio installation reads it. */
interface ProjectBody {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Who made it, by username; absent for an account that has been deleted. */
  readonly createdBy?: string;
  readonly createdAt: number;
  /** The remote to clone, which is the address Studio would otherwise be told. */
  readonly remote: string;
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

function projectBody(
  database: DatabaseSync,
  config: IdentityConfig,
  project: ProjectRecord,
): ProjectBody {
  const maker = findUserById(database, project.createdBy);
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    ...(maker === undefined ? {} : { createdBy: maker.username }),
    createdAt: project.createdAt,
    // Built from what this server was started with rather than stored, for the
    // same reason the discovery document is: the address a project is reached
    // at is a fact about the deployment, not about the project.
    remote: dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort),
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
 * Returns false for everything else, so the router goes on to the interface
 * and the pages without this having to know they exist.
 */
export function serveStudioApi(
  options: StudioApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (path !== PROJECTS) {
    return false;
  }
  if (request.method === "GET") {
    void answerProjectList(options, request, response);
    return true;
  }
  if (request.method === "POST") {
    void answerProjectCreate(options, request, response);
    return true;
  }
  response.writeHead(405, { allow: "GET, POST", "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "that address takes GET and POST" }));
  return true;
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
    projectBody(options.database, options.config, project),
  );
  options.log?.(`studio: ${user.username} listed ${projects.length} project(s)`);
  sendJson(response, 200, { projects });
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
  sendJson(response, 201, { project: projectBody(options.database, options.config, project) });
}

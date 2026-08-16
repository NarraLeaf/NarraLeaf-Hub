/**
 * The web interface's API, which is four routes and one rule.
 *
 * The rule is that this file decides nothing. A page asks for a view and gets
 * the same {@link TeamView} the terminal interface draws; it asks for something
 * to be done and hands over the same {@link Action} the terminal interface
 * sends, which reaches the same `perform`. What a project is, when an account
 * may be disabled and what sentence to say afterwards are answered in one place
 * for both interfaces, and this is not that place.
 *
 *     POST /api/sign-in     a username and a password, for a session cookie
 *     POST /api/sign-out    give the cookie back
 *     GET  /api/view        everything on the screen, as one document
 *     POST /api/action      do one thing, and say what it did
 *     GET  /api/events      the same views again as they change, over SSE
 *
 * Who may sign in
 * ---------------
 * Administrators, and nobody else. The terminal interface is described as the
 * operator's view, and this is that view in a browser: it shows every account,
 * every project and every decision the server has made, without a notion of
 * looking at one's own row. A member who signed in would either see all of that
 * or see a second, narrower interface that would have to be designed, tested
 * and kept true. Refusing at the door is the smaller and more honest of the
 * two, and it is one sentence rather than a policy spread over five surfaces.
 *
 * Cross-site requests
 * -------------------
 * There are no CORS headers here, on any route, so a page on another origin
 * cannot read an answer. What it could still do without more is *cause* one, so
 * every write takes three things: a `SameSite=Strict` cookie, a body sent as
 * `application/json` — which a form cannot send and a script cannot send
 * cross-origin without a preflight this server never approves — and an `origin`
 * header that either is absent or matches the host asked for.
 *
 * Which language it answers in
 * ----------------------------
 * Whatever the request asks for, per request, and nothing is remembered here.
 * A session does not carry a language: two tabs of the same account may be open
 * in two languages, and an operator who switches language mid-session is asking
 * about the next sentence rather than about their account.
 */
import { perform } from "../actions.js";
import { describeError } from "../i18n/errors.js";
import { en, messagesFor, type Messages } from "../i18n/index.js";
import { isLocale, LANGUAGE_HEADER, negotiateLocale } from "../i18n/locales.js";
import { defaultPasswordHasher } from "../identity/passwords.js";
import { authenticate } from "../identity/users.js";
import type { Action } from "../tui/state.js";
import type { TeamView } from "../tui/teamview.js";
import type { ViewContext } from "../view.js";
import {
  clearedSessionCookie,
  readCookie,
  sessionCookie,
  SESSION_COOKIE,
  type SessionStore,
} from "./sessions.js";

import type { IncomingMessage, ServerResponse } from "node:http";

/** The path everything here hangs under. */
export const API_PREFIX = "/api";

/**
 * The header a page names its language in, named in src/i18n/locales.ts so that
 * both halves spell it the same way.
 *
 * Sent beside `accept-language` rather than instead of it, and read first,
 * because the two answer different questions: the browser's header is what this
 * machine is set up to read, and this one is what the person at it chose in the
 * interface. Somebody reading a Japanese page on an English laptop means the
 * second, and the sentence an action answers with has to arrive in the language
 * the rest of their screen is in.
 */
export { LANGUAGE_HEADER } from "../i18n/locales.js";

/** The group an account has to be in to open the web interface. */
export const OPERATOR_ROLE = "admin";

/**
 * The largest body this will read.
 *
 * A sign-in is two short strings and the widest action is a project name and a
 * username. Anything past this is not a request that got long, it is a request
 * that is trying something, and reading it would be the only work it managed to
 * make this server do.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * How long a failed sign-in is held before it is answered.
 *
 * Password checking is already slow on purpose — scrypt at OWASP's parameters
 * costs a few hundred milliseconds — so this is not about the cost of a guess.
 * It is about the rate of them: with this, one connection gets at most a couple
 * of attempts a second, and the sentence it is answered with says nothing about
 * which half was wrong anyway.
 */
const REFUSED_SIGN_IN_DELAY_MS = 500;

/** What the web interface needs in order to answer. */
export interface ApiOptions {
  readonly context: ViewContext;
  readonly sessions: SessionStore;
  /** Gather the current view. The same call the terminal interface refreshes with. */
  readonly gather: () => Promise<TeamView>;
  /** Ask for the repositories to be read again; it must not be waited on. */
  readonly request: () => void;
  /** Called with each new view, for the event stream. Returns an unsubscribe. */
  readonly subscribe: (listen: (view: TeamView) => void) => () => void;
  /** Somewhere to say what happened, in the same place `up` says everything else. */
  readonly log?: (line: string) => void;
}

/** Who this request is, once it has been let in. */
interface Operator {
  readonly username: string;
  readonly displayName: string;
  readonly role: string;
  readonly expiresAt: number;
}

/**
 * The language to answer one request in.
 *
 * Exported because the router answers a few things before this file is reached
 * — a page that is switched off, an address that is nothing — and they are read
 * by the same person.
 */
export function languageOf(request: IncomingMessage): Messages {
  const chosen = request.headers[LANGUAGE_HEADER];
  const named = Array.isArray(chosen) ? chosen[0] : chosen;
  if (isLocale(named)) {
    return messagesFor(named);
  }
  const accepted = request.headers["accept-language"];
  return messagesFor(negotiateLocale(Array.isArray(accepted) ? accepted[0] : accepted));
}

function sendJson(response: ServerResponse, status: number, body: unknown, cookie?: string): void {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // Nothing here is worth a second look: a view is a moment, and a stale one
    // drawn from a cache is a screen that lies about a server that has moved on.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(cookie === undefined ? {} : { "set-cookie": cookie }),
  });
  response.end(text);
}

/** Read a JSON body, or say what was wrong with it. */
async function readJsonBody(
  request: IncomingMessage,
  messages: Messages,
): Promise<unknown | { error: string }> {
  const type = request.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    // The cross-site guard as much as a content check: a form on somebody
    // else's page can post to this URL, but it cannot post this content type.
    return { error: messages.refusal.needsJson };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      return { error: messages.refusal.tooLong };
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return { error: messages.refusal.notJson };
  }
}

function isError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string";
}

/**
 * Whether a request that means to change something came from this interface.
 *
 * An absent `origin` is allowed: a browser sends one on every request that can
 * do harm, and a command-line client which sends none has a session cookie only
 * because somebody deliberately gave it one. A present one that names another
 * host is refused, which is the case the header exists for.
 */
function originIsOurs(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined || origin === "null") {
    return origin === undefined;
  }
  const host = request.headers.host;
  if (host === undefined) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Wait, without holding the process open if it is on its way out. */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

/** Whether an account is in the group that may open this interface. */
export function isOperator(groups: readonly string[]): boolean {
  return groups.includes(OPERATOR_ROLE);
}

/**
 * Answer one API request. Returns false when the path is not one of ours, so
 * the router can go on to the pages.
 */
export function serveApi(
  options: ApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): boolean {
  if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) {
    return false;
  }

  const route = path.slice(API_PREFIX.length);
  void answer(options, request, response, route).catch((error: unknown) => {
    // Anything that reaches here is a failure nobody planned for, and a socket
    // left open is worse than a sentence: the page would wait for ever on a
    // request that is never coming back.
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`nlteam: web interface: ${message}`);
    if (!response.headersSent) {
      sendJson(response, 500, { error: languageOf(request).refusal.wentWrong });
    } else {
      response.end();
    }
  });
  return true;
}

async function answer(
  options: ApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  route: string,
): Promise<void> {
  const method = request.method ?? "GET";
  const secret = readCookie(request.headers.cookie, SESSION_COOKIE);
  const messages = languageOf(request);

  switch (`${method} ${route}`) {
    case "POST /sign-in":
      await signIn(options, request, response, messages);
      return;
    case "POST /sign-out":
      options.sessions.close(secret);
      sendJson(response, 200, { ok: true }, clearedSessionCookie());
      return;
    case "GET /session": {
      const operator = whoIs(options, secret);
      if (operator === undefined) {
        sendJson(response, 200, { signedIn: false });
        return;
      }
      sendJson(response, 200, { signedIn: true, operator });
      return;
    }
    case "GET /view": {
      if (whoIs(options, secret) === undefined) {
        refuse(response, messages);
        return;
      }
      options.request();
      sendJson(response, 200, await options.gather());
      return;
    }
    case "GET /events": {
      if (whoIs(options, secret) === undefined) {
        refuse(response, messages);
        return;
      }
      stream(options, request, response);
      return;
    }
    case "POST /action": {
      const operator = whoIs(options, secret);
      if (operator === undefined) {
        refuse(response, messages);
        return;
      }
      await act(options, request, response, operator, messages);
      return;
    }
    default:
      sendJson(response, 404, { error: messages.refusal.nothingAtThatAddress });
  }
}

/** Say no, in the one way a page knows how to act on. */
function refuse(response: ServerResponse, messages: Messages): void {
  // 401 rather than 403 whatever the reason: the page's answer to all of them
  // is the same, which is to show the sign-in form again.
  sendJson(response, 401, { error: messages.refusal.notSignedIn }, clearedSessionCookie());
}

/** Who this request is, or nobody. */
function whoIs(options: ApiOptions, secret: string | undefined): Operator | undefined {
  const identified = options.sessions.identify(options.context.database, secret);
  if (identified.kind === "refused") {
    return undefined;
  }
  const { user } = identified;
  // Checked on every request rather than at sign-in alone: an account taken out
  // of the operators between one page and the next has been taken out of this
  // interface too.
  if (!isOperator(user.groups)) {
    return undefined;
  }
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.groups.length === 0 ? "none" : user.groups.join(","),
    expiresAt: identified.expiresAt,
  };
}

async function signIn(
  options: ApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  messages: Messages,
): Promise<void> {
  if (!originIsOurs(request)) {
    sendJson(response, 403, { error: messages.refusal.fromSomewhereElse });
    return;
  }

  const body = await readJsonBody(request, messages);
  if (isError(body)) {
    sendJson(response, 400, body);
    return;
  }
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string") {
    sendJson(response, 400, { error: messages.refusal.needUsernameAndPassword });
    return;
  }

  const { database } = options.context;
  const result = await authenticate(database, defaultPasswordHasher(), username, password);
  if (result.kind === "refused") {
    // One sentence for every way it can fail, as `nlteam token mint` does:
    // whoever is at the other end learns nothing about which accounts exist.
    await pause(REFUSED_SIGN_IN_DELAY_MS);
    options.log?.(`web: sign-in refused for ${JSON.stringify(username)}`);
    sendJson(response, 401, { error: messages.refusal.signInRefused });
    return;
  }

  if (!isOperator(result.user.groups)) {
    // A different sentence, and it can be: the password was right, so there is
    // nothing left to hide from whoever typed it. Saying "you are not an
    // operator here" is what stops a member trying their password again.
    await pause(REFUSED_SIGN_IN_DELAY_MS);
    options.log?.(`web: sign-in refused for ${result.user.username}, who is not an ${OPERATOR_ROLE}`);
    sendJson(response, 403, {
      error: messages.refusal.notAnOperator({ group: OPERATOR_ROLE }),
    });
    return;
  }

  const { secret, expiresAt } = options.sessions.open(database, result.user);
  options.log?.(`web: ${result.user.username} signed in`);
  sendJson(
    response,
    200,
    {
      signedIn: true,
      operator: {
        username: result.user.username,
        displayName: result.user.displayName,
        role: result.user.groups.join(","),
        expiresAt,
      },
    },
    sessionCookie(secret, expiresAt, Date.now()),
  );
}

async function act(
  options: ApiOptions,
  request: IncomingMessage,
  response: ServerResponse,
  operator: Operator,
  messages: Messages,
): Promise<void> {
  if (!originIsOurs(request)) {
    sendJson(response, 403, { error: messages.refusal.fromSomewhereElse });
    return;
  }

  const body = await readJsonBody(request, messages);
  if (isError(body)) {
    sendJson(response, 400, body);
    return;
  }

  const action = readAction(body, messages);
  if (typeof action === "string") {
    sendJson(response, 400, { error: action });
    return;
  }

  try {
    const message = await perform(options.context, action, messages);
    options.log?.(`web: ${operator.username}: ${action.kind}: ${message}`);
    // A view is gathered after every action rather than left to the stream, so
    // that the page which asked draws the result of its own request instead of
    // the state just before it.
    options.request();
    sendJson(response, 200, { message, view: await options.gather() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The log is English, always: it is read beside everything else `up`
    // prints, by whoever is at the server rather than by whoever pressed the
    // button. Only the answer is translated.
    options.log?.(`web: ${operator.username}: ${action.kind} failed: ${message}`);
    // 400, not 500: everything `perform` throws is a thing about the request —
    // an account that is not there, a name already taken, a loreserver that
    // refused. The sentence is the one the command would have printed, in the
    // language it was asked in.
    sendJson(response, 400, { error: describeError(error, messages) });
  }
}

/**
 * Take an action apart, refusing anything that is not one.
 *
 * Written out per kind rather than cast, because this is the one place a
 * browser reaches `perform`: a body that arrived as `{kind: "grant"}` with no
 * project must be refused here, not discovered as a SQL error three calls
 * later. `quit` is not among them — it means "close the terminal", and a
 * browser closing its own tab needs no help from the server.
 */
export function readAction(body: unknown, messages: Messages = en): Action | string {
  const refusal = messages.refusal;
  if (typeof body !== "object" || body === null) {
    return refusal.notAnAction;
  }
  const candidate = body as Record<string, unknown>;
  const kind = candidate.kind;
  const text = (name: string): string | undefined =>
    typeof candidate[name] === "string" && (candidate[name] as string).length > 0
      ? (candidate[name] as string)
      : undefined;

  switch (kind) {
    case "refresh":
    case "rotate-key":
    case "restart-loreserver":
      return { kind };
    case "create-project": {
      const name = text("name");
      const owner = text("owner");
      if (name === undefined || owner === undefined) {
        return refusal.projectNeedsNameAndOwner;
      }
      return { kind, name, owner };
    }
    case "set-user-disabled": {
      const username = text("username");
      if (username === undefined || typeof candidate.disabled !== "boolean") {
        return refusal.needsAccountAndDisabled;
      }
      return { kind, username, disabled: candidate.disabled };
    }
    case "revoke-tokens": {
      const username = text("username");
      if (username === undefined) {
        return refusal.needsAccount;
      }
      return { kind, username };
    }
    case "set-setting": {
      const value = text("value");
      if (typeof candidate.index !== "number" || !Number.isInteger(candidate.index) || value === undefined) {
        return refusal.settingNeedsRowAndValue;
      }
      return { kind, index: candidate.index, value };
    }
    default:
      return refusal.notSomethingWeDo;
  }
}

/**
 * Send every new view down one connection, as server-sent events.
 *
 * A stream rather than the page asking again every few seconds: a gather walks
 * the whole storage root, and a page left open on a wall display would do that
 * for ever. The connection is watched from both ends — the browser reconnects
 * on its own, and closing it here unsubscribes — so a tab that goes away stops
 * costing anything.
 */
function stream(options: ApiOptions, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });

  const send = (view: TeamView): void => {
    response.write(`data: ${JSON.stringify(view)}\n\n`);
  };

  const unsubscribe = options.subscribe(send);

  // A comment line every half minute. Nothing reads it; it is there so that a
  // proxy or a laptop's network stack does not decide a silent connection is a
  // dead one and close it under a page that is working perfectly.
  const heartbeat = setInterval(() => {
    response.write(": still here\n\n");
  }, 30_000);
  heartbeat.unref();

  const done = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on("close", done);
  response.on("close", done);

  // The current view at once, so a page that has just connected draws
  // something rather than waiting for the next thing to change.
  void options.gather().then(send, () => {
    // A gather that failed leaves the stream open with nothing on it. The next
    // change publishes, and the page goes on showing what it had.
  });
}

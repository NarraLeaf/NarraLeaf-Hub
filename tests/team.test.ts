/**
 * A session, end to end.
 *
 * Driven with node's own WebSocket client rather than anything out of src, on
 * purpose: a client written beside the server agrees with it about the parts
 * both got wrong. What is asserted here is the door, the shape of the opening
 * frame, what a call answers, what a subscription is told, and the one thing a
 * request-and-response API could never do - somebody else's write arriving on a
 * connection that did not make it.
 *
 * Plain HTTP rather than TLS. What TLS decides on this listener is who may
 * connect at all, and that is settled in tests/certificates.test.ts and by the
 * one measured fact this design rests on: the `upgrade` event does fire on the
 * HTTP/2 secure listener that `allowHTTP1` puts in front of the same port. What
 * is left over is the protocol, and the protocol does not know which it is on.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig, type IdentityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import { createUser, disableUser, requireUser } from "../src/identity/users.js";
import { createProject, forgetProject, newProjectId } from "../src/projects/registry.js";
import { createTeamSocket, type TeamSocket } from "../src/team/endpoint.js";
import {
  TEAM_METHODS,
  TEAM_SOCKET_PATH,
  projectThreadsTopic,
  TOPIC_PROJECTS,
  type TeamHelloFrame,
} from "../src/team/protocol.js";
import type { StudioApiOptions } from "../src/web/studio.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-session-");

/** Cheap parameters: nothing here is about what a hash costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const openServers: Server[] = [];
const openDatabases: DatabaseSync[] = [];
const openClients: Client[] = [];

afterEach(async () => {
  while (openClients.length > 0) {
    openClients.pop()?.close();
  }
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

interface Harness {
  readonly origin: string;
  readonly database: DatabaseSync;
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
  readonly service: StudioApiOptions;
  readonly socket: TeamSocket;
  readonly tokenFor: (username: string) => string;
  readonly connect: (token: string) => Promise<Client>;
}

async function harness(): Promise<Harness> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});

  const service: StudioApiOptions = {
    database,
    keys,
    config,
    dataPort: config.dataPort,
  };
  const socket = createTeamSocket({ service, version: "0.0.0-test", host: "127.0.0.1" });

  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (upgrade, raw, head) => {
    if (!socket.handleUpgrade(upgrade, raw, head)) {
      raw.destroy();
    }
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const origin = `127.0.0.1:${port}`;

  const tokenFor = (username: string): string =>
    mintToken(requireUser(database, username), keys.signingKey, config, {
      purpose: "sign-in",
    }).token;

  return {
    origin,
    database,
    keys,
    config,
    service,
    socket,
    tokenFor,
    connect: async (token: string) => {
      const client = await open(`ws://${origin}${TEAM_SOCKET_PATH}`, token);
      openClients.push(client);
      return client;
    },
  };
}

async function account(database: DatabaseSync, username: string): Promise<string> {
  const user = await createUser(database, hasher, {
    username,
    password: "a password nobody guesses",
    displayName: username,
  });
  return user.id;
}

/* --------------------------------------------------------------- a client */

interface Waiting {
  resolve: (value: { value?: unknown; code?: string; message?: string; seq?: number }) => void;
}

/** Everything a test does with a session, over node's own WebSocket. */
class Client {
  readonly events: { topic: string; seq: number; payload: unknown }[] = [];
  readonly byes: { code: string; message: string }[] = [];
  hello: TeamHelloFrame | undefined;

  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (message: MessageEvent) => {
      const frame = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (frame["t"] === "hello") {
        this.hello = frame as unknown as TeamHelloFrame;
      } else if (frame["t"] === "event") {
        this.events.push(
          frame as unknown as { topic: string; seq: number; payload: unknown },
        );
      } else if (frame["t"] === "bye") {
        this.byes.push(frame as unknown as { code: string; message: string });
      } else if (typeof frame["id"] === "number") {
        this.waiting.get(frame["id"])?.resolve(frame as never);
        this.waiting.delete(frame["id"]);
      }
      for (const listener of this.listeners.splice(0)) {
        listener();
      }
    };
  }

  /** Ask, and hand back the whole answering frame, refusals included. */
  send(
    t: "call" | "subscribe" | "unsubscribe",
    extra: Record<string, unknown>,
  ): Promise<{ value?: unknown; code?: string; message?: string; seq?: number }> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve });
      this.ws.send(JSON.stringify({ t, id, ...extra }));
    });
  }

  call(method: string, params?: unknown): Promise<{ value?: unknown; code?: string }> {
    return this.send("call", { method, ...(params === undefined ? {} : { params }) });
  }

  /** What a call answered, insisting it was not a refusal. */
  async value(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const answer = await this.call(method, params);
    if (answer.code !== undefined) {
      throw new Error(`${method} was refused: ${answer.code}`);
    }
    return answer.value as Record<string, unknown>;
  }

  /**
   * Wait until something is true of what has arrived.
   *
   * A predicate rather than "one more frame", because an event can land before
   * the call that caused it has answered: a handler publishes and then returns,
   * so by the time a test has awaited the write, the frame it is waiting for is
   * often already in hand. Waiting for the next one after that waits forever.
   */
  async until(condition: () => boolean, within = 4000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > within) {
        throw new Error("what the test was waiting for never arrived");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  send_raw(text: string): void {
    this.ws.send(text);
  }

  close(): void {
    this.ws.close();
  }
}

function open(url: string, token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);
    const client = new Client(ws);
    ws.onerror = () => reject(new Error("the socket would not open"));
    ws.onmessage = ws.onmessage;
    const started = Date.now();
    const settle = (): void => {
      if (client.hello !== undefined) {
        resolve(client);
        return;
      }
      if (Date.now() - started > 4000) {
        reject(new Error("no hello frame arrived"));
        return;
      }
      setTimeout(settle, 5);
    };
    ws.onopen = () => settle();
  });
}

/** The status an upgrade was refused with, for the cases that never become a socket. */
function upgradeStatus(origin: string, path: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = httpRequest({
      host: origin.split(":")[0],
      port: Number(origin.split(":")[1]),
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });
    call.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    call.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    call.on("error", reject);
    call.end();
  });
}

/* ----------------------------------------------------------------- tests */

describe("opening a session", () => {
  it("refuses one with no token, in HTTP rather than as a close code", async () => {
    const team = await harness();
    expect(await upgradeStatus(team.origin, TEAM_SOCKET_PATH)).toBe(401);
  });

  it("refuses one whose token this server did not sign", async () => {
    const team = await harness();
    expect(await upgradeStatus(team.origin, TEAM_SOCKET_PATH, "not.a.token")).toBe(401);
  });

  it("refuses one whose account has been disabled", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const token = team.tokenFor("ada");
    disableUser(team.database, "ada");
    expect(await upgradeStatus(team.origin, TEAM_SOCKET_PATH, token)).toBe(401);
  });

  it("says who is calling, what it serves, and what it speaks", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));

    expect(client.hello?.protocol).toBe(1);
    expect(client.hello?.account.username).toBe("ada");
    expect(client.hello?.account.operator).toBe(false);
    expect(client.hello?.methods).toContain(TEAM_METHODS.projectsList);
    expect(client.hello?.methods).toContain(TEAM_METHODS.threadsCreate);
    // Announced from the table of methods rather than written down beside it.
    expect(client.hello?.capabilities).toEqual(
      expect.arrayContaining(["session", "comments"]),
    );
  });
});

describe("calling", () => {
  it("answers the same projects the REST route lists", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });
    const client = await team.connect(team.tokenFor("ada"));

    const answer = await client.value(TEAM_METHODS.projectsList);
    const projects = answer["projects"] as { name: string; remote: string }[];
    expect(projects.map((project) => project.name)).toEqual(["lighthouse"]);
    // The name is on the end of the remote, which is the thing a client cannot
    // clone without.
    expect(projects[0]?.remote.endsWith("/lighthouse")).toBe(true);
  });

  it("says so when it has no such method, rather than going quiet", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    expect((await client.call("projects.invent")).code).toBe("unknown-method");
  });

  it("refuses a project that is not on this server as not-found", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    expect((await client.call(TEAM_METHODS.projectsGet, { project: "nope" })).code).toBe(
      "not-found",
    );
  });
});

describe("subscribing", () => {
  it("says where a topic stands, and refuses one nobody publishes", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));

    const good = await client.send("subscribe", { topic: TOPIC_PROJECTS });
    expect(good.seq).toBe(0);
    expect((await client.send("subscribe", { topic: "weather" })).code).toBe("not-found");
  });

  it("refuses a project topic for a project that is not here", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    expect((await client.send("subscribe", { topic: "project:nope" })).code).toBe("not-found");
  });

  it("carries what somebody else did to whoever asked to be told", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    await account(team.database, "bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });

    const watcher = await team.connect(team.tokenFor("bob"));
    await watcher.send("subscribe", { topic: projectThreadsTopic(project.id) });

    const writer = await team.connect(team.tokenFor("ada"));
    await writer.value(TEAM_METHODS.threadsCreate, {
      project: project.id,
      anchor: { document: "story/act-one.json", element: "row-14" },
      body: "this line lands flat",
    });

    await watcher.until(() => watcher.events.length > 0);
    expect(watcher.events).toHaveLength(1);
    expect(watcher.events[0]?.seq).toBe(1);
    const payload = watcher.events[0]?.payload as { kind: string; thread: { anchor: unknown } };
    expect(payload.kind).toBe("thread-created");
    // The anchor comes back exactly as it went in. This server stores those
    // strings and never reads them.
    expect(payload.thread.anchor).toEqual({
      document: "story/act-one.json",
      element: "row-14",
    });
  });

  it("does not carry it to a session that did not ask", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    await account(team.database, "bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: ada,
    });

    const quiet = await team.connect(team.tokenFor("bob"));
    const writer = await team.connect(team.tokenFor("ada"));
    await writer.value(TEAM_METHODS.threadsCreate, {
      project: project.id,
      anchor: { document: "story/act-one.json" },
      body: "nobody is listening",
    });

    expect(quiet.events).toEqual([]);
  });
});

describe("conversations", () => {
  async function withProject(): Promise<{
    team: Harness;
    project: string;
    ada: Client;
    bob: Client;
  }> {
    const team = await harness();
    const adaId = await account(team.database, "ada");
    await account(team.database, "bob");
    const project = createProject(team.database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: adaId,
    });
    return {
      team,
      project: project.id,
      ada: await team.connect(team.tokenFor("ada")),
      bob: await team.connect(team.tokenFor("bob")),
    };
  }

  it("opens a thread, and lists it back with its opening comment", async () => {
    const { project, ada } = await withProject();
    await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json", element: "row-14", revision: "abc123" },
      body: "this line lands flat",
    });

    const listed = await ada.value(TEAM_METHODS.threadsList, { project });
    const threads = listed["threads"] as {
      status: string;
      comments: number;
      opening: { body: string };
      anchor: { revision?: string };
    }[];
    expect(threads).toHaveLength(1);
    expect(threads[0]?.status).toBe("open");
    expect(threads[0]?.comments).toBe(1);
    expect(threads[0]?.opening.body).toBe("this line lands flat");
    expect(threads[0]?.anchor.revision).toBe("abc123");
  });

  it("narrows a list to one place inside a document", async () => {
    const { project, ada } = await withProject();
    for (const element of ["row-1", "row-2"]) {
      await ada.value(TEAM_METHODS.threadsCreate, {
        project,
        anchor: { document: "story/act-one.json", element },
        body: `about ${element}`,
      });
    }
    const listed = await ada.value(TEAM_METHODS.threadsList, {
      project,
      document: "story/act-one.json",
      element: "row-2",
    });
    expect((listed["threads"] as unknown[]).length).toBe(1);
  });

  it("makes one thread out of a write that was sent twice", async () => {
    const { project, ada } = await withProject();
    const params = {
      project,
      anchor: { document: "story/act-one.json", element: "row-14" },
      body: "said once",
      clientId: "aa11",
    };
    const first = await ada.value(TEAM_METHODS.threadsCreate, params);
    const again = await ada.value(TEAM_METHODS.threadsCreate, params);
    expect((again["thread"] as { id: string }).id).toBe((first["thread"] as { id: string }).id);

    const listed = await ada.value(TEAM_METHODS.threadsList, { project });
    expect((listed["threads"] as unknown[]).length).toBe(1);
  });

  it("lets anybody reply and anybody resolve", async () => {
    const { project, ada, bob } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "opening",
    });
    const thread = (opened["thread"] as { id: string }).id;

    await bob.value(TEAM_METHODS.threadsReply, { thread, body: "agreed" });
    const resolved = await bob.value(TEAM_METHODS.threadsResolve, { thread });
    expect((resolved["thread"] as { status: string }).status).toBe("resolved");

    const whole = await ada.value(TEAM_METHODS.threadsGet, { thread });
    expect((whole["comments"] as unknown[]).length).toBe(2);
  });

  it("refuses to let one person edit another's words", async () => {
    const { project, ada, bob } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "mine",
    });
    const comment = (opened["comment"] as { id: string }).id;

    const refusal = await bob.call(TEAM_METHODS.commentsEdit, { comment, body: "not mine" });
    expect(refusal.code).toBe("refused");
    const deletion = await bob.call(TEAM_METHODS.commentsDelete, { comment });
    expect(deletion.code).toBe("refused");
  });

  it("keeps a withdrawn comment in its place, without its body", async () => {
    const { project, ada } = await withProject();
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "opening",
    });
    const thread = (opened["thread"] as { id: string }).id;
    await ada.value(TEAM_METHODS.threadsReply, { thread, body: "second thoughts" });
    const reply = await ada.value(TEAM_METHODS.threadsGet, { thread });
    const second = (reply["comments"] as { id: string }[])[1];

    await ada.value(TEAM_METHODS.commentsDelete, { comment: second?.id });

    const after = await ada.value(TEAM_METHODS.threadsGet, { thread });
    const comments = after["comments"] as { body: string; deletedAt?: number }[];
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toBe("");
    expect(comments[1]?.deletedAt).toBeGreaterThan(0);
  });

  it("insists a suggestion carries what it suggests", async () => {
    const { project, ada } = await withProject();
    const refusal = await ada.call(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      kind: "suggestion",
      body: "try this instead",
    });
    expect(refusal.code).toBe("bad-params");
  });

  it("hands a suggestion back exactly as it arrived, having read none of it", async () => {
    const { project, ada } = await withProject();
    const proposal = JSON.stringify({ text: "The lighthouse went dark.", speaker: "narrator" });
    const opened = await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json", element: "row-14" },
      kind: "suggestion",
      body: "try this instead",
      suggestion: proposal,
    });
    expect((opened["comment"] as { suggestion: string }).suggestion).toBe(proposal);
    expect((opened["thread"] as { kind: string }).kind).toBe("suggestion");
  });

  it("takes a project's conversations off with the project", async () => {
    const { team, project, ada } = await withProject();
    await ada.value(TEAM_METHODS.threadsCreate, {
      project,
      anchor: { document: "story/act-one.json" },
      body: "opening",
    });

    forgetProject(team.database, project);

    const rows = team.database
      .prepare("SELECT COUNT(*) AS total FROM threads WHERE project_id = ?")
      .get(project) as { total: number };
    expect(rows.total).toBe(0);
    const orphans = team.database
      .prepare("SELECT COUNT(*) AS total FROM comments")
      .get() as { total: number };
    expect(orphans.total).toBe(0);
  });
});

describe("what a session refuses to carry on with", () => {
  it("ends on a frame that is not JSON", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    client.send_raw("not json");
    await client.until(() => client.byes.length > 0);
    expect(client.byes[0]?.code).toBe("bad-params");
  });

  it("ends on a frame of a kind it does not speak", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const client = await team.connect(team.tokenFor("ada"));
    client.send_raw(JSON.stringify({ t: "shout", id: 1 }));
    await client.until(() => client.byes.length > 0);
    expect(client.byes[0]?.code).toBe("bad-params");
  });
});

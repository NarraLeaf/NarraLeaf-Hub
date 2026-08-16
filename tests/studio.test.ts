/**
 * The API a Studio installation talks to.
 *
 * What is worth asserting here is the door and the list. The door, because the
 * token is the whole of the authentication and a token this refused would be a
 * token that reached a repository anyway. The list, because it is the answer to
 * the question this API exists for — and because it is the same list whoever
 * asks, which is the rule the rest of the server was rebuilt around.
 *
 * Creating a project is not exercised end to end here: it asks loreserver for a
 * repository, and a test that started one would be testing loreserver. What is
 * covered is everything up to that call.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import {
  createUser,
  disableUser,
  requireUser,
  revokeUserTokens,
} from "../src/identity/users.js";
import type { DiscoveryDocument } from "../src/identity/discovery.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-studio-");

/** Cheap parameters: these tests are about the door, not what a hash costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const PASSWORD = "a password nobody guesses";
const PATH = "/api/studio/v1/projects";

const DISCOVERY: DiscoveryDocument = {
  protocol: 1,
  name: "127.0.0.1",
  auth: { required: true, url: "https://127.0.0.1:41402" },
  data: { url: "lore://127.0.0.1:41337" },
  authority: { sha256: "" },
  version: "0.0.0-test",
};

const openServers: Server[] = [];
const openDatabases: DatabaseSync[] = [];

afterEach(async () => {
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
  /** A token for one account, as `nlteam token mint` would produce. */
  readonly tokenFor: (username: string) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  openDatabases.push(database);
  const keys = await KeyStore.open(layout.keysDir);
  const config = identityConfig({});

  const server = createServer(
    webHandler(DISCOVERY, {
      studio: { database, keys, config, dataPort: config.dataPort },
    }),
  );
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    database,
    tokenFor: (username: string): Promise<string> =>
      Promise.resolve(
        mintToken(requireUser(database, username), keys.signingKey, config, {
          purpose: "sign-in",
        }).token,
      ),
  };
}

async function account(database: DatabaseSync, username: string): Promise<string> {
  const user = await createUser(database, hasher, { username, password: PASSWORD });
  return user.id;
}

async function get(origin: string, token?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${PATH}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

describe("the projects a Studio installation is shown", () => {
  it("refuses a request carrying no token", async () => {
    const team = await harness();

    const answer = await get(team.origin);

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: expect.stringContaining("bearer") });
  });

  it("refuses a token this server did not sign", async () => {
    const team = await harness();

    const answer = await get(team.origin, "not.a.token");

    expect(answer.status).toBe(401);
  });

  it("is empty on a server with no projects, rather than absent", async () => {
    const team = await harness();
    await account(team.database, "ada");

    const answer = await get(team.origin, await team.tokenFor("ada"));

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ projects: [] });
  });

  it("is the same list whoever asks, because every account reaches every project", async () => {
    const team = await harness();
    const ada = await account(team.database, "ada");
    await account(team.database, "bob");
    createProject(team.database, {
      id: newProjectId(),
      name: "harbour",
      description: "the one everybody is working on",
      createdBy: ada,
    });

    const hers = await get(team.origin, await team.tokenFor("ada"));
    const his = await get(team.origin, await team.tokenFor("bob"));

    expect(hers.body).toEqual(his.body);
    expect(hers.body).toMatchObject({
      projects: [
        {
          name: "harbour",
          description: "the one everybody is working on",
          // Who made it is shown; it is not what decides who may open it.
          createdBy: "ada",
          // The address Studio would otherwise have to be told by hand, with the
          // project's name on the end: a client refuses one without it.
          remote: "lore://127.0.0.1:41337/harbour",
        },
      ],
    });
  });

  it("refuses an account that has been disabled", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const token = await team.tokenFor("ada");
    disableUser(team.database, "ada");

    expect((await get(team.origin, token)).status).toBe(401);
  });

  it("refuses a token that revoking made stale", async () => {
    const team = await harness();
    await account(team.database, "ada");
    const token = await team.tokenFor("ada");
    revokeUserTokens(team.database, "ada");

    expect((await get(team.origin, token)).status).toBe(401);
  });

  it("says what a project needs when it is asked to make one without a name", async () => {
    const team = await harness();
    await account(team.database, "ada");

    const response = await fetch(`${team.origin}${PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await team.tokenFor("ada")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ description: "no name" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "a project needs a name" });
  });

  it("takes GET and POST, and says so about anything else", async () => {
    const team = await harness();

    const response = await fetch(`${team.origin}${PATH}`, { method: "DELETE" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });

  it("is served whether or not the web interface is on", async () => {
    // The interface is off in this harness — no `api` — and this answered
    // anyway. A server that only listed projects for operators who had switched
    // a page on would be one every author was locked out of.
    const team = await harness();
    await account(team.database, "ada");

    expect((await get(team.origin, await team.tokenFor("ada"))).status).toBe(200);
  });
});

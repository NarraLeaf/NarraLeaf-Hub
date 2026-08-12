import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { GrpcCallError, unaryCall } from "../src/grpc/client.js";
import {
  decodeCheckUserPermissionResponse,
  decodeLookupUserPermissionsResponse,
  encodeCheckUserPermissionRequest,
  encodeCreateResourceRequest,
  encodeDeleteResourceRequest,
  encodeLookupUserPermissionsRequest,
  METHOD_CHECK_USER_PERMISSION,
  METHOD_CREATE_RESOURCE,
  METHOD_DELETE_RESOURCE,
  METHOD_LOOKUP_USER_PERMISSIONS,
} from "../src/grpc/messages.js";
import type { GrpcServer } from "../src/grpc/server.js";
import { GRPC_UNIMPLEMENTED } from "../src/grpc/status.js";
import { listDecisions } from "../src/identity/audit.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { mintToken } from "../src/identity/tokens.js";
import {
  createUser,
  disableUser,
  enableUser,
  requireUser,
  type UserRecord,
} from "../src/identity/users.js";
import {
  accessLevel,
  createProject,
  findProject,
  grantAccess,
  newProjectId,
  resourceIdOf,
} from "../src/projects/registry.js";
import { startAuthorizationService } from "../src/projects/service.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlhub-auth-");

const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);
const config = identityConfig();

/**
 * A running authorization service with a database behind it.
 *
 * The service is driven over a real socket rather than by calling its handlers:
 * the framing, the headers and the trailers are as much of the mechanism as the
 * decision is, and a handler called directly exercises none of them.
 */
interface Harness {
  readonly database: DatabaseSync;
  readonly server: GrpcServer;
  readonly keys: KeyStore;
  /** Every line the service wrote, in order. */
  readonly log: string[];
  user(username: string): Promise<UserRecord>;
  /** A token for `user`, as an `authorization` header value. */
  bearer(user: UserRecord, options?: { readonly now?: Date }): string;
  check(authorization: string | undefined, resourceIds: readonly string[]): Promise<string[]>;
  lookup(authorization: string | undefined): Promise<string[]>;
}

const started: Harness[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const harness = started.pop();
    if (harness === undefined) {
      continue;
    }
    await harness.server.close();
    harness.database.close();
  }
});

async function harness(): Promise<Harness> {
  const layout = identityLayout(await temporaryRoot());
  const database = await openMigratedDatabase(layout.databasePath);
  const keys = await KeyStore.open(layout.keysDir);
  const log: string[] = [];
  // Port 0: the operating system picks one that is free, so a test run cannot
  // collide with a Hub the machine is already running.
  const server = await startAuthorizationService({
    port: 0,
    database,
    keys,
    config,
    log: (line) => log.push(line),
  });

  const call = async (
    path: string,
    message: Uint8Array,
    authorization: string | undefined,
  ): Promise<Buffer> =>
    await unaryCall({
      url: server.url,
      path,
      message,
      ...(authorization === undefined ? {} : { authorization }),
      timeoutMs: 5000,
    });

  const instance: Harness = {
    database,
    server,
    keys,
    log,
    async user(username: string): Promise<UserRecord> {
      await createUser(database, hasher, { username, password: "a password nobody guesses" });
      return requireUser(database, username);
    },
    bearer(user: UserRecord, options = {}): string {
      return `Bearer ${mintToken(user, keys.signingKey, config, options).token}`;
    },
    async check(authorization, resourceIds): Promise<string[]> {
      const reply = await call(
        METHOD_CHECK_USER_PERMISSION,
        encodeCheckUserPermissionRequest({ resourceIds }),
        authorization,
      );
      return decodeCheckUserPermissionResponse(reply).allowed.map((entry) => entry.resourceId);
    },
    async lookup(authorization): Promise<string[]> {
      const reply = await call(
        METHOD_LOOKUP_USER_PERMISSIONS,
        encodeLookupUserPermissionsRequest({ resourceFilter: "" }),
        authorization,
      );
      return decodeLookupUserPermissionsResponse(reply).permissions.map(
        (entry) => entry.resourceId,
      );
    },
  };

  started.push(instance);
  return instance;
}

describe("CheckUserPermission", () => {
  it("answers with the projects the grant table says the caller may reach", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const bob = await hub.user("bob");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const resource = resourceIdOf(project.id);

    expect(await hub.check(hub.bearer(ada), [resource])).toEqual([resource]);
    expect(await hub.check(hub.bearer(bob), [resource])).toEqual([]);

    // And a grant takes effect at once: nothing is cached, and no token is
    // reissued in between.
    grantAccess(hub.database, project.id, bob.id, "read", ada.id);
    expect(await hub.check(hub.bearer(bob), [resource])).toEqual([resource]);
  });

  it("returns only the granted subset when asked about several at once", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const bob = await hub.user("bob");
    const hers = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const shared = createProject(hub.database, {
      id: newProjectId(),
      name: "lighthouse",
      createdBy: bob.id,
    });
    const his = createProject(hub.database, {
      id: newProjectId(),
      name: "quayside",
      createdBy: bob.id,
    });
    grantAccess(hub.database, shared.id, ada.id, "write", bob.id);

    const asked = [
      resourceIdOf(hers.id),
      resourceIdOf(shared.id),
      resourceIdOf(his.id),
      "urc-not-a-project-of-this-hub",
    ];

    expect(await hub.check(hub.bearer(ada), asked)).toEqual([
      resourceIdOf(hers.id),
      resourceIdOf(shared.id),
    ]);
  });

  it("names the resource exactly as it was asked about", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    // loreserver compares the two strings and accepts nothing else, so an
    // answer rebuilt from the project rather than echoed would read as an
    // answer about something else. Asking in upper case is the cheapest way to
    // tell an echo from a reconstruction.
    const shouted = resourceIdOf(project.id).toUpperCase();

    expect(await hub.check(hub.bearer(ada), [shouted])).toEqual([shouted]);
  });

  it("refuses everything for a token from a disabled account", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    // Minted while the account was still in good standing, which is the only
    // interesting case: a token nobody can obtain proves nothing.
    const token = hub.bearer(ada);
    expect(await hub.check(token, [resourceIdOf(project.id)])).toEqual([resourceIdOf(project.id)]);

    disableUser(hub.database, "ada");

    expect(await hub.check(token, [resourceIdOf(project.id)])).toEqual([]);
    expect(hub.log.at(-1)).toContain("the account is disabled");
  });

  it("refuses a token issued before the account's access was revoked", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const token = hub.bearer(ada);

    // Disabling bumps the epoch; enabling deliberately does not put it back, so
    // this is an account that may sign in again holding a token that is dead.
    disableUser(hub.database, "ada");
    enableUser(hub.database, "ada");

    expect(await hub.check(token, [resourceIdOf(project.id)])).toEqual([]);
    expect(hub.log.at(-1)).toContain("before the account's access was revoked");
    // A token minted now is at the new epoch and works.
    expect(await hub.check(hub.bearer(requireUser(hub.database, "ada")), [
      resourceIdOf(project.id),
    ])).toEqual([resourceIdOf(project.id)]);
  });

  it("refuses an expired token", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    // Last year, not an hour ago: a token minted to sign in with lasts thirty
    // days, and the sentence being checked is about a token past its `exp`.
    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    expect(await hub.check(hub.bearer(ada, { now: lastYear }), [resourceIdOf(project.id)])).toEqual(
      [],
    );
    expect(hub.log.at(-1)).toContain("the token has expired");
  });

  it("refuses a token whose claims were changed after it was signed", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const bob = await hub.user("bob");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const [header, , signature] = hub.bearer(ada).slice("Bearer ".length).split(".");
    const claims = Buffer.from(
      JSON.stringify({
        iss: config.issuer,
        aud: [config.audience],
        sub: bob.id,
        env: config.env,
        name: bob.displayName,
        preferred_username: bob.username,
        groups: [],
        is_service_account: false,
        idp: config.idp,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
        token_epoch: 1,
      }),
      "utf8",
    ).toString("base64url");

    const forged = `Bearer ${header}.${claims}.${signature}`;

    expect(await hub.check(forged, [resourceIdOf(project.id)])).toEqual([]);
    expect(hub.log.at(-1)).toContain("signature");
  });

  it("refuses a call carrying no token at all", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    expect(await hub.check(undefined, [resourceIdOf(project.id)])).toEqual([]);
    expect(hub.log.at(-1)).toContain("no bearer token");
  });

  it("writes one line per decision, with the caller, the resource and the outcome", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    await hub.check(hub.bearer(ada), [resourceIdOf(project.id), "urc-something-else"]);

    expect(hub.log).toEqual([
      `auth: check ada ${resourceIdOf(project.id)}: allowed (owner)`,
      "auth: check ada urc-something-else: denied, not a project on this Hub",
    ]);
  });

  it("keeps the same decisions where something other than this process can read them", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    await hub.check(hub.bearer(ada), [resourceIdOf(project.id), "urc-something-else"]);

    // Under the project's name, not its resource id: this is what a person
    // reads, and it goes on saying which project it was about after the project
    // is gone. A resource Hub knows nothing about keeps the id, because that is
    // all there is to know about it.
    expect(listDecisions(hub.database)).toEqual([
      {
        at: expect.any(Number),
        username: "ada",
        resource: "urc-something-else",
        allowed: false,
        detail: "not a project on this Hub",
      },
      {
        at: expect.any(Number),
        username: "ada",
        resource: "harbour",
        allowed: true,
        detail: "owner",
      },
    ]);
  });

  it("keeps a refusal it cannot name anybody for", async () => {
    const hub = await harness();

    await hub.check(undefined, ["urc-anything"]);

    expect(listDecisions(hub.database)).toMatchObject([
      { username: "unknown", resource: "urc-anything", allowed: false },
    ]);
    // The reason the log gave, kept with it. A refusal recorded as a refusal
    // and nothing else would make an expired token look like a missing grant.
    expect(listDecisions(hub.database)[0]?.detail).toBe("the call carried no bearer token");
  });
});

describe("LookupUserPermissions", () => {
  it("answers each caller with their own projects", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const bob = await hub.user("bob");
    const hers = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    const his = createProject(hub.database, {
      id: newProjectId(),
      name: "lighthouse",
      createdBy: bob.id,
    });
    grantAccess(hub.database, his.id, ada.id, "read", bob.id);

    expect(await hub.lookup(hub.bearer(ada))).toEqual([
      resourceIdOf(hers.id),
      resourceIdOf(his.id),
    ]);
    expect(await hub.lookup(hub.bearer(bob))).toEqual([resourceIdOf(his.id)]);
  });

  it("answers nobody with nothing", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    createProject(hub.database, { id: newProjectId(), name: "harbour", createdBy: ada.id });

    expect(await hub.lookup(undefined)).toEqual([]);
  });
});

describe("the resource lifecycle calls", () => {
  it("records a repository loreserver says it created", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });

    const reply = await unaryCall({
      url: hub.server.url,
      path: METHOD_CREATE_RESOURCE,
      message: encodeCreateResourceRequest({
        resourceId: resourceIdOf(project.id),
        resourceName: "harbour",
      }),
      timeoutMs: 5000,
    });

    // An empty message, which is what CreateResourceResponse is.
    expect(reply).toHaveLength(0);
    expect(hub.log.at(-1)).toContain("the project harbour");
    expect(findProject(hub.database, project.id)).toBeDefined();
  });

  it("forgets a project when its owner is behind the deletion, and not otherwise", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const bob = await hub.user("bob");
    const project = createProject(hub.database, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada.id,
    });
    grantAccess(hub.database, project.id, bob.id, "write", ada.id);

    const remove = async (authorization: string | undefined): Promise<void> => {
      await unaryCall({
        url: hub.server.url,
        path: METHOD_DELETE_RESOURCE,
        message: encodeDeleteResourceRequest({ resourceId: resourceIdOf(project.id) }),
        ...(authorization === undefined ? {} : { authorization }),
        timeoutMs: 5000,
      });
    };

    await remove(undefined);
    expect(findProject(hub.database, project.id)).toBeDefined();

    await remove(hub.bearer(bob));
    expect(findProject(hub.database, project.id)).toBeDefined();
    expect(hub.log.at(-1)).toContain("does not own it");

    await remove(hub.bearer(ada));
    expect(findProject(hub.database, project.id)).toBeUndefined();
    expect(accessLevel(hub.database, project.id, bob.id)).toBeUndefined();
  });
});

describe("the rest of the protocol", () => {
  it("answers UNIMPLEMENTED for a method it does not serve", async () => {
    const hub = await harness();

    const failure = await unaryCall({
      url: hub.server.url,
      path: "/epic_urc.UrcAuthApi/StartAuthSession",
      message: Buffer.alloc(0),
      timeoutMs: 5000,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GrpcCallError);
    expect((failure as GrpcCallError).status).toBe(GRPC_UNIMPLEMENTED);
  });
});

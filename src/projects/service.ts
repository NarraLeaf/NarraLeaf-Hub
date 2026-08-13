/**
 * The service loreserver asks about a caller.
 *
 * loreserver does not decide who may touch a repository. It asks, over gRPC, at
 * the address in its `auth_url` — which is this — forwarding the caller's own
 * `authorization` header. What it does with the answer, measured against
 * loreserver 0.8.6, is narrower than the protocol suggests:
 *
 *   - It calls `CheckUserPermission` with one resource id, `urc-` followed by
 *     the repository id in lower-case hex.
 *   - It accepts the answer if and only if `allowed_resource_permission[0]`
 *     names that same id. The `permission` list is never read. An empty allow
 *     list is "No permissions for resource"; a different id is "Unexpected
 *     resource_id"; the client is told "not found" for either.
 *   - It calls `LookupUserPermissions` to find out which repositories to put in
 *     a listing.
 *   - It calls `RebacApi/CreateResource` after creating a repository, and
 *     `DeleteResource` after deleting one.
 *
 * So the allow list is the whole of the decision, and an id that is present is
 * an id the caller may open. Everything else in the reply is for the log and
 * for whoever reads this next.
 *
 * Every decision is written to the log with the caller, the resource and the
 * outcome, and kept in the database by src/identity/audit.ts. Nothing else in
 * the system records who reached what: loreserver logs that it asked, not what
 * it was told, and a refusal reaches the person as "not found".
 */
import type { DatabaseSync } from "node:sqlite";

import {
  decodeCheckUserPermissionRequest,
  decodeCreateResourceRequest,
  decodeDeleteResourceRequest,
  decodeExchangeExternalTokenForUserTokenRequest,
  decodeExchangeUserTokenForMultiresourceTokenRequest,
  decodeLookupUserPermissionsRequest,
  encodeCheckUserPermissionResponse,
  encodeExchangeExternalTokenForUserTokenResponse,
  encodeExchangeUserTokenForMultiresourceTokenResponse,
  encodeHealthCheckResponse,
  encodeLookupUserPermissionsResponse,
  EMPTY_MESSAGE,
  METHOD_CHECK_USER_PERMISSION,
  METHOD_CREATE_RESOURCE,
  METHOD_DELETE_RESOURCE,
  METHOD_EXCHANGE_EXTERNAL_TOKEN,
  METHOD_EXCHANGE_MULTIRESOURCE_TOKEN,
  METHOD_HEALTH_CHECK,
  METHOD_LOOKUP_USER_PERMISSIONS,
  type ResourcePermission,
} from "../grpc/messages.js";
import { GrpcServer, type GrpcCall, type GrpcMethod } from "../grpc/server.js";
import {
  GRPC_PERMISSION_DENIED,
  GRPC_UNAUTHENTICATED,
  GrpcStatusError,
} from "../grpc/status.js";
import {
  recordDecision,
  UNIDENTIFIED_ACCOUNT,
  type NewDecision,
} from "../identity/audit.js";
import {
  bearerToken,
  describeRefusal,
  identifyToken,
  type CallerIdentification,
} from "../identity/bearer.js";
import type { IdentityConfig } from "../identity/config.js";
import type { KeyStore } from "../identity/keys.js";
import { storedTokenLifetimes, type TokenLifetimes } from "../identity/settings.js";
import { mintToken, type ResourceClaim } from "../identity/tokens.js";
import {
  accessLevel,
  findProject,
  forgetProject,
  listProjectsFor,
  permissionsFor,
  projectIdFromResourceId,
  resourceIdOf,
} from "./registry.js";

/** Everything the service needs to answer a question. */
export interface AuthorizationContext {
  readonly database: DatabaseSync;
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
  /**
   * Token lifetimes named on the command line this Team server was started with.
   *
   * Absent is the ordinary case, and then the stored settings decide. What an
   * operator typed has to outrank them, or `up --token-lifetime` would stop
   * doing anything the moment somebody stored the setting it names.
   */
  readonly namedLifetimes?: Partial<TokenLifetimes>;
  /** Where one line per decision goes. */
  readonly log: (line: string) => void;
}

/**
 * The settings to mint with, carrying the two token lifetimes as they stand in
 * the database at this moment.
 *
 * Read per mint rather than kept from the start, so that shortening a lifetime
 * reaches a Team server that is already running instead of waiting for somebody to
 * restart it. It is one row fetched by primary key out of a local SQLite file,
 * beside the several queries each of these calls already makes.
 */
function mintingConfig(context: AuthorizationContext): IdentityConfig {
  return {
    ...context.config,
    ...storedTokenLifetimes(context.database),
    ...context.namedLifetimes,
  };
}

/** What a caller is called in the log when there is nobody to name. */
const UNIDENTIFIED = "an unidentified caller";

/**
 * What a decision is filed under when it is not about one project.
 *
 * Short nouns, because they sit in the same column as a project's name on a
 * screen that is often narrow.
 */
const SIGN_IN = "sign-in";
const LISTING = "listing";
const DATA_CONNECTION = "data connection";
const NOTHING = "nothing";

/**
 * Say what was decided, once, to both places it has to go.
 *
 * The log line and the record are written side by side rather than one derived
 * from the other: the line is a sentence for somebody watching a terminal, and
 * the record is five fields for somebody looking at a screen a week later.
 * Writing both at one call site is what stops either being forgotten; the two
 * calls that stay on `context.log` alone are the ones where Team decided
 * nothing, and each of them says so.
 */
function decided(context: AuthorizationContext, line: string, decision: NewDecision): void {
  context.log(line);
  recordDecision(context.database, decision);
}

/**
 * The name a decision about `resourceId` is filed under.
 *
 * Resolved as the decision is made rather than as the log is read, so that the
 * record still says which project it was about after that project has been
 * deleted from this Team server. A resource Team knows nothing about keeps its resource
 * id, which is all there is to say about it.
 *
 * It costs one lookup by primary key in a local SQLite file, on a call that has
 * already verified an RSA signature.
 */
function resourceName(context: AuthorizationContext, resourceId: string): string {
  const projectId = projectIdFromResourceId(resourceId);
  const project = projectId === undefined ? undefined : findProject(context.database, projectId);
  return project?.name ?? resourceId;
}

/**
 * Identify whoever the question is about.
 *
 * Normally that is the bearer of the token loreserver forwarded. A request may
 * instead name a `target_user` holding a token of its own, and then the
 * question is about that person — answering about the bearer would be an answer
 * to a different question.
 *
 * A `kid` this process has not seen sends it back to the keys directory once. A
 * key can be rotated while Team is running, by `nlteam key rotate` in another
 * terminal, and the tokens signed by the new one are valid from the moment it
 * exists.
 */
async function identify(
  context: AuthorizationContext,
  call: GrpcCall,
  targetUserToken: string | undefined,
): Promise<CallerIdentification> {
  const token = targetUserToken ?? bearerToken(call.authorization);
  const identification = identifyToken(context.database, context.keys, context.config, token);
  if (identification.kind === "refused" && identification.reason === "unknown-key") {
    await context.keys.reload();
    return identifyToken(context.database, context.keys, context.config, token);
  }
  return identification;
}

/** `UrcAuthApi/CheckUserPermission`: which of these may the caller reach? */
async function checkUserPermission(
  context: AuthorizationContext,
  call: GrpcCall,
): Promise<Buffer> {
  const request = decodeCheckUserPermissionRequest(call.message);
  const caller = await identify(context, call, request.targetUser?.userToken);

  if (caller.kind === "refused") {
    const because = describeRefusal(caller.reason);
    // One line per resource, and one line even when the request named none, so
    // that a refusal is never a gap in the log.
    if (request.resourceIds.length === 0) {
      decided(context, `auth: check ${UNIDENTIFIED} for nothing: refused, ${because}`, {
        username: UNIDENTIFIED_ACCOUNT,
        resource: NOTHING,
        allowed: false,
        detail: because,
      });
    }
    for (const resourceId of request.resourceIds) {
      decided(context, `auth: check ${UNIDENTIFIED} ${resourceId}: refused, ${because}`, {
        username: UNIDENTIFIED_ACCOUNT,
        resource: resourceName(context, resourceId),
        allowed: false,
        detail: because,
      });
    }
    // An empty allow list, not a gRPC failure. A refusal is an answer to the
    // question loreserver asked, and it turns into "not found" for the client
    // either way; failing the call would make an expired token look like a
    // broken authorization service.
    return encodeCheckUserPermissionResponse({ allowed: [], denied: [] });
  }

  const allowed: ResourcePermission[] = [];
  const denied: ResourcePermission[] = [];
  for (const resourceId of request.resourceIds) {
    const projectId = projectIdFromResourceId(resourceId);
    const level = projectId === undefined ? undefined : accessLevel(
      context.database,
      projectId,
      caller.user.id,
    );
    if (level === undefined) {
      denied.push({ resourceId, permission: [] });
      const why = projectId === undefined ? "not a project on this server" : "no grant";
      decided(context, `auth: check ${caller.user.username} ${resourceId}: denied, ${why}`, {
        username: caller.user.username,
        resource: resourceName(context, resourceId),
        allowed: false,
        detail: why,
      });
      continue;
    }
    // The id is echoed exactly as it was asked about, not rebuilt from the
    // project: loreserver compares the two strings, and a rebuilt one that
    // differed in any character would read as an answer about something else.
    allowed.push({ resourceId, permission: permissionsFor(level) });
    decided(context, `auth: check ${caller.user.username} ${resourceId}: allowed (${level})`, {
      username: caller.user.username,
      resource: resourceName(context, resourceId),
      allowed: true,
      detail: level,
    });
  }

  return encodeCheckUserPermissionResponse({ allowed, denied });
}

/** `UrcAuthApi/LookupUserPermissions`: everything the caller may reach. */
async function lookupUserPermissions(
  context: AuthorizationContext,
  call: GrpcCall,
): Promise<Buffer> {
  const request = decodeLookupUserPermissionsRequest(call.message);
  const caller = await identify(context, call, undefined);

  if (caller.kind === "refused") {
    const because = describeRefusal(caller.reason);
    decided(context, `auth: lookup ${UNIDENTIFIED}: refused, ${because}`, {
      username: UNIDENTIFIED_ACCOUNT,
      resource: LISTING,
      allowed: false,
      detail: because,
    });
    return encodeLookupUserPermissionsResponse({ permissions: [] });
  }

  // The filter is honoured only when it names one resource outright. Team has
  // one kind of resource — a project — so a filter that is anything else, a
  // wildcard or a category name, would be a pattern language guessed at rather
  // than agreed, and guessing wrong here silently shortens somebody's listing.
  const only = projectIdFromResourceId(request.resourceFilter);
  const reachable = listProjectsFor(context.database, caller.user.id).filter(
    (entry) => only === undefined || entry.project.id === only,
  );

  decided(
    context,
    `auth: lookup ${caller.user.username}: ${reachable.length} project(s)${
      only === undefined ? "" : ` matching ${request.resourceFilter}`
    }`,
    {
      username: caller.user.username,
      resource: LISTING,
      allowed: true,
      detail: `${reachable.length} project(s)`,
    },
  );

  // Every project in one reply. Paging exists in the protocol and is not used:
  // the page a caller would be asked to come back for is a handful of rows out
  // of one local database.
  return encodeLookupUserPermissionsResponse({
    permissions: reachable.map((entry) => ({
      resourceId: resourceIdOf(entry.project.id),
      permission: permissionsFor(entry.level),
    })),
  });
}

/**
 * `UrcAuthApi/ExchangeExternalTokenForUserToken`: signing in.
 *
 * This is the one method a Studio installation calls before it can do anything
 * else, and the reason the TLS listener exists at all. What a client presents
 * is a token this Team server minted — `nlteam token mint`, which is what a person is
 * given after proving who they are with their password — and what it gets back
 * is a fresh one.
 *
 * Minting rather than echoing is the whole point of the exchange. The presented
 * token is proof of identity and nothing more; the token that comes back is
 * issued now, so it carries the account's `token_epoch` as it stands now, and
 * an account that has been disabled or had its access revoked in the meantime
 * gets nothing. Echoing would turn a token with a lifetime into one that
 * renews itself for ever.
 *
 * A refusal is a gRPC status, not a success carrying no token. A client reading
 * an empty `user_token` on an OK reply has no way to tell a refusal from a
 * server that has lost its keys.
 */
function exchangeExternalToken(context: AuthorizationContext, call: GrpcCall): Buffer {
  const request = decodeExchangeExternalTokenForUserTokenRequest(call.message);
  // The token is taken from the request, not from the `authorization` header:
  // a client signing in has nothing to put in that header yet, and the field is
  // where its library puts what it was given. `token_type` is passed through by
  // the client and read by nobody; Team knows only one kind of token.
  const presented = request.externalToken === "" ? undefined : request.externalToken;
  const caller = identifyToken(context.database, context.keys, context.config, presented);

  if (caller.kind === "refused") {
    const because = describeRefusal(caller.reason);
    decided(context, `auth: exchange ${UNIDENTIFIED}: refused, ${because}`, {
      username: UNIDENTIFIED_ACCOUNT,
      resource: SIGN_IN,
      allowed: false,
      detail: because,
    });
    // One status and one sentence for every refusal, unlike the permission
    // calls: this is the sign-in path, and the caller is whoever reached the
    // endpoint. Saying which check failed would say whether an account exists.
    throw new GrpcStatusError(
      GRPC_UNAUTHENTICATED,
      "the token presented for exchange was not accepted",
    );
  }

  // Every project this account may reach, named in the token.
  //
  // A client opens its data connection and authorizes it with this token,
  // before it has asked for anything narrower — and loreserver refuses a token
  // that reaches `StorageAuthorizeTask` with no `resources` claim, having
  // decoded it perfectly well. A sign-in token with no resources therefore
  // signs in, resolves a repository, and then cannot read a byte of it.
  const reachable = listProjectsFor(context.database, caller.user.id).map((entry) => ({
    resource_id: resourceIdOf(entry.project.id),
    permission: permissionsFor(entry.level),
  }));

  // The sign-in lifetime, which is the long one. This token comes back here to
  // be exchanged and is asked about again on every repository access, so
  // revoking an account's tokens refuses it without waiting for it to expire.
  const minted = mintToken(caller.user, context.keys.signingKey, mintingConfig(context), {
    purpose: "sign-in",
    resources: reachable,
  });
  decided(
    context,
    `auth: exchange ${caller.user.username}: issued a token for ${reachable.length} ` +
      `project(s) until ${new Date(minted.claims.exp * 1000).toISOString()}`,
    {
      username: caller.user.username,
      resource: SIGN_IN,
      allowed: true,
      detail: `a token for ${reachable.length} project(s)`,
    },
  );

  return encodeExchangeExternalTokenForUserTokenResponse({
    userToken: {
      userToken: minted.token,
      expiresAt: minted.claims.exp,
      // The account's id, which is also the token's `sub`. A client requires a
      // caller's configured identity to equal this, so it is what a Studio
      // installation has to be told about itself.
      userId: caller.user.id,
      userName: caller.user.displayName,
    },
  });
}

/**
 * `UrcAuthApi/ExchangeUserTokenForMultiresourceToken`: a token for the data
 * connection.
 *
 * Signing in is not enough to open a repository. Before a client touches a
 * repository's data it exchanges the user token it holds for one scoped to the
 * resources it is about to use, and it presents that token on the QUIC storage
 * connection rather than the one it signed in with. Without this method the
 * sequence gets remarkably far and then stops: the client signs in, resolves
 * the repository over gRPC — which Team allows, and logs as allowed — and then
 * fails with "Not connected to remote: Not authorized to access repository",
 * while loreserver records `MissingToken` against a `StorageAuthorizeTask`.
 * Nothing in either message says a method is missing.
 *
 * Team answers by checking every resource the client named and minting a fresh
 * token, because a token minted now carries the account's state now. The scope
 * is not written into the token: loreserver goes on asking
 * {@link checkUserPermission} about every access, so a token that named
 * resources it should not would still be refused at the point of use. What this
 * call adds is that a caller with no grant is stopped here, before any data
 * connection is opened at all.
 */
function exchangeMultiresourceToken(context: AuthorizationContext, call: GrpcCall): Buffer {
  const request = decodeExchangeUserTokenForMultiresourceTokenRequest(call.message);
  const caller = identifyToken(
    context.database,
    context.keys,
    context.config,
    bearerToken(call.authorization),
  );

  if (caller.kind === "refused") {
    const because = describeRefusal(caller.reason);
    decided(
      context,
      `auth: multiresource ${UNIDENTIFIED} for ${request.resourceIds.length} resource(s): ` +
        `refused, ${because}`,
      {
        username: UNIDENTIFIED_ACCOUNT,
        resource: DATA_CONNECTION,
        allowed: false,
        detail: because,
      },
    );
    throw new GrpcStatusError(
      GRPC_UNAUTHENTICATED,
      "the token presented for exchange was not accepted",
    );
  }

  // Every resource, not merely one of them: the token being asked for covers
  // all of them at once, and handing one out for a set that includes something
  // the caller may not have would be handing out the wrong thing.
  const granted: ResourceClaim[] = [];
  for (const resourceId of request.resourceIds) {
    const projectId = projectIdFromResourceId(resourceId);
    const level =
      projectId === undefined
        ? undefined
        : accessLevel(context.database, projectId, caller.user.id);
    if (level === undefined) {
      const why = projectId === undefined ? "not a project on this server" : "no grant";
      decided(
        context,
        `auth: multiresource ${caller.user.username} ${resourceId}: denied, ${why}`,
        {
          username: caller.user.username,
          resource: resourceName(context, resourceId),
          allowed: false,
          detail: why,
        },
      );
      // PERMISSION_DENIED rather than an empty answer: the caller is identified,
      // and the question was whether this account may have this project. A
      // reply carrying no token would reach the person as a client that could
      // not find its own credentials.
      throw new GrpcStatusError(
        GRPC_PERMISSION_DENIED,
        "this account has no access to one of the resources it asked for",
      );
    }
    // The id is echoed exactly as it was asked about, for the reason
    // checkUserPermission echoes it: the comparison downstream is on the string.
    granted.push({ resource_id: resourceId, permission: permissionsFor(level) });
    decided(
      context,
      `auth: multiresource ${caller.user.username} ${resourceId}: allowed (${level})`,
      {
        username: caller.user.username,
        resource: resourceName(context, resourceId),
        allowed: true,
        detail: level,
      },
    );
  }

  // The resources are named in the token itself. This is what makes it a
  // multiresource token rather than another user token, and it is what the
  // storage connection reads.
  // The repository lifetime, which is the short one, and this is the call that
  // makes the pair worth having. What is minted here is presented on the data
  // connection, to loreserver's data plane, and Team is not necessarily asked
  // about it again — so the expiry is the only thing that ends it.
  const minted = mintToken(caller.user, context.keys.signingKey, mintingConfig(context), {
    purpose: "repository",
    resources: granted,
  });
  return encodeExchangeUserTokenForMultiresourceTokenResponse({
    token: {
      userToken: minted.token,
      expiresAt: minted.claims.exp,
      userId: caller.user.id,
      userName: caller.user.displayName,
    },
  });
}

/**
 * `RebacApi/CreateResource`: loreserver saying a repository now exists.
 *
 * It arrives just after `nlteam project create` asked for the repository, so the
 * project is already recorded and its owner already granted — this is a second
 * telling of something Team caused. It is recorded in the log and nothing is
 * written, because a project row needs a creator and this call names nobody.
 *
 * A resource Team has never heard of is logged and otherwise let be: it is a
 * repository created by something other than Team, and inventing a project for
 * it would be inventing an owner.
 *
 * Nothing is recorded as a decision, because nothing was decided: no caller is
 * named and no access is granted or refused. A row here would be a line on the
 * screen of decisions saying that a project somebody had just created existed.
 */
function createResource(context: AuthorizationContext, call: GrpcCall): Buffer {
  const request = decodeCreateResourceRequest(call.message);
  const projectId = projectIdFromResourceId(request.resourceId);
  const project = projectId === undefined ? undefined : findProject(context.database, projectId);

  context.log(
    `auth: create resource ${request.resourceId} "${request.resourceName}": ${
      project === undefined ? "no project of this server" : `the project ${project.name}`
    }`,
  );
  return EMPTY_MESSAGE;
}

/**
 * `RebacApi/DeleteResource`: loreserver saying a repository is gone.
 *
 * The project is forgotten when the caller owns it, which is the only case in
 * which somebody with the authority to delete it has been shown to be behind
 * the call. Otherwise the row stays and the log says so: a stale row denies
 * nobody anything, and a row deleted on an unauthenticated call would take
 * everyone's access with it.
 *
 * Either way the call is answered with OK. The repository is already gone by
 * the time this arrives, and failing the call would only make loreserver report
 * a delete that did happen as a delete that failed.
 */
async function deleteResource(context: AuthorizationContext, call: GrpcCall): Promise<Buffer> {
  const request = decodeDeleteResourceRequest(call.message);
  const projectId = projectIdFromResourceId(request.resourceId);
  const project = projectId === undefined ? undefined : findProject(context.database, projectId);
  const caller = await identify(context, call, undefined);
  const who = caller.kind === "identified" ? caller.user.username : UNIDENTIFIED;

  if (project === undefined) {
    context.log(`auth: delete resource ${who} ${request.resourceId}: no project of this Team server`);
    return EMPTY_MESSAGE;
  }
  const level =
    caller.kind === "identified"
      ? accessLevel(context.database, project.id, caller.user.id)
      : undefined;
  if (level !== "owner") {
    const why =
      caller.kind === "identified" ? "the caller does not own it" : describeRefusal(caller.reason);
    decided(context, `auth: delete resource ${who} ${request.resourceId}: kept, ${why}`, {
      username: caller.kind === "identified" ? who : UNIDENTIFIED_ACCOUNT,
      resource: project.name,
      allowed: false,
      detail: `kept, ${why}`,
    });
    return EMPTY_MESSAGE;
  }

  forgetProject(context.database, project.id);
  // Recorded after the project row is gone, and holding the name rather than a
  // reference to it: this is the one decision whose subject no longer exists by
  // the time anybody reads about it.
  decided(
    context,
    `auth: delete resource ${who} ${request.resourceId}: forgot the project ${project.name}`,
    {
      username: who,
      resource: project.name,
      allowed: true,
      detail: "forgot the project",
    },
  );
  return EMPTY_MESSAGE;
}

/**
 * The methods this service answers, by path.
 *
 * Everything else in `UrcAuthApi` — sessions, API keys, user metadata — is
 * absent on purpose, and the server answers `UNIMPLEMENTED` for it. An empty
 * reply would be indistinguishable from a real answer meaning "no permissions",
 * and a caller would act on it.
 *
 * The same methods are served on both listeners. loreserver reaches the
 * plaintext one over the loopback and a client reaches the TLS one; neither is
 * given anything the other is not, because the decision every method makes is
 * about the token presented, not about where the connection came from.
 */
export function authorizationMethods(
  context: AuthorizationContext,
): Readonly<Record<string, GrpcMethod>> {
  return {
    [METHOD_CHECK_USER_PERMISSION]: (call) => checkUserPermission(context, call),
    [METHOD_LOOKUP_USER_PERMISSIONS]: (call) => lookupUserPermissions(context, call),
    [METHOD_EXCHANGE_EXTERNAL_TOKEN]: (call) => exchangeExternalToken(context, call),
    [METHOD_EXCHANGE_MULTIRESOURCE_TOKEN]: (call) => exchangeMultiresourceToken(context, call),
    [METHOD_CREATE_RESOURCE]: (call) => createResource(context, call),
    [METHOD_DELETE_RESOURCE]: (call) => deleteResource(context, call),
    // Answered because it is part of the service loreserver was pointed at, and
    // a health check that fails is a service that looks down.
    [METHOD_HEALTH_CHECK]: () => encodeHealthCheckResponse("SERVING"),
  };
}

/** What the service needs beyond its context. */
export interface AuthorizationServiceOptions extends AuthorizationContext {
  readonly port: number;
  /** Interface to listen on; the loopback by default. */
  readonly host?: string;
  /** True to listen on every interface rather than the loopback. */
  readonly anyInterface?: boolean;
  /** The certificate and key for a TLS listener; absent for a plaintext one. */
  readonly tls?: { readonly cert: string; readonly key: string };
  /** The option that moves this listener, for the message if it cannot start. */
  readonly portOption?: string;
  /** Called for a failure that belongs to no call. */
  readonly onError?: (error: Error) => void;
}

/** Start the authorization service. */
export async function startAuthorizationService(
  options: AuthorizationServiceOptions,
): Promise<GrpcServer> {
  return await GrpcServer.start({
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.anyInterface === undefined ? {} : { anyInterface: options.anyInterface }),
    methods: authorizationMethods(options),
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.portOption === undefined ? {} : { portOption: options.portOption }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}

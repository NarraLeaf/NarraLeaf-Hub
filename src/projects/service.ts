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
 * outcome. Nothing else in the system records who reached what: loreserver logs
 * that it asked, not what it was told, and a refusal reaches the person as
 * "not found".
 */
import type { DatabaseSync } from "node:sqlite";

import {
  decodeCheckUserPermissionRequest,
  decodeCreateResourceRequest,
  decodeDeleteResourceRequest,
  decodeExchangeExternalTokenForUserTokenRequest,
  decodeLookupUserPermissionsRequest,
  encodeCheckUserPermissionResponse,
  encodeExchangeExternalTokenForUserTokenResponse,
  encodeHealthCheckResponse,
  encodeLookupUserPermissionsResponse,
  EMPTY_MESSAGE,
  METHOD_CHECK_USER_PERMISSION,
  METHOD_CREATE_RESOURCE,
  METHOD_DELETE_RESOURCE,
  METHOD_EXCHANGE_EXTERNAL_TOKEN,
  METHOD_HEALTH_CHECK,
  METHOD_LOOKUP_USER_PERMISSIONS,
  type ResourcePermission,
} from "../grpc/messages.js";
import { GrpcServer, type GrpcCall, type GrpcMethod } from "../grpc/server.js";
import { GRPC_UNAUTHENTICATED, GrpcStatusError } from "../grpc/status.js";
import {
  bearerToken,
  describeRefusal,
  identifyToken,
  type CallerIdentification,
} from "../identity/bearer.js";
import type { IdentityConfig } from "../identity/config.js";
import type { KeyStore } from "../identity/keys.js";
import { mintToken } from "../identity/tokens.js";
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
  /** Where one line per decision goes. */
  readonly log: (line: string) => void;
}

/** What a caller is called in the log when there is nobody to name. */
const UNIDENTIFIED = "an unidentified caller";

/**
 * Identify whoever the question is about.
 *
 * Normally that is the bearer of the token loreserver forwarded. A request may
 * instead name a `target_user` holding a token of its own, and then the
 * question is about that person — answering about the bearer would be an answer
 * to a different question.
 *
 * A `kid` this process has not seen sends it back to the keys directory once. A
 * key can be rotated while Hub is running, by `nlhub key rotate` in another
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
      context.log(`auth: check ${UNIDENTIFIED} for nothing: refused, ${because}`);
    }
    for (const resourceId of request.resourceIds) {
      context.log(`auth: check ${UNIDENTIFIED} ${resourceId}: refused, ${because}`);
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
      context.log(
        `auth: check ${caller.user.username} ${resourceId}: denied, ${
          projectId === undefined ? "not a project on this Hub" : "no grant"
        }`,
      );
      continue;
    }
    // The id is echoed exactly as it was asked about, not rebuilt from the
    // project: loreserver compares the two strings, and a rebuilt one that
    // differed in any character would read as an answer about something else.
    allowed.push({ resourceId, permission: permissionsFor(level) });
    context.log(`auth: check ${caller.user.username} ${resourceId}: allowed (${level})`);
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
    context.log(`auth: lookup ${UNIDENTIFIED}: refused, ${describeRefusal(caller.reason)}`);
    return encodeLookupUserPermissionsResponse({ permissions: [] });
  }

  // The filter is honoured only when it names one resource outright. Hub has
  // one kind of resource — a project — so a filter that is anything else, a
  // wildcard or a category name, would be a pattern language guessed at rather
  // than agreed, and guessing wrong here silently shortens somebody's listing.
  const only = projectIdFromResourceId(request.resourceFilter);
  const reachable = listProjectsFor(context.database, caller.user.id).filter(
    (entry) => only === undefined || entry.project.id === only,
  );

  context.log(
    `auth: lookup ${caller.user.username}: ${reachable.length} project(s)${
      only === undefined ? "" : ` matching ${request.resourceFilter}`
    }`,
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
 * is a token this Hub minted — `nlhub token mint`, which is what a person is
 * given after proving who they are with their password — and what it gets back
 * is a fresh one.
 *
 * Minting rather than echoing is the whole point of the exchange. The presented
 * token is proof of identity and nothing more; the token that comes back is
 * issued now, so it carries the account's `token_epoch` as it stands now, and
 * an account that has been disabled or had its access revoked in the meantime
 * gets nothing. Echoing would turn a fifteen-minute token into one that renews
 * itself for ever.
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
  // the client and read by nobody; Hub knows only one kind of token.
  const presented = request.externalToken === "" ? undefined : request.externalToken;
  const caller = identifyToken(context.database, context.keys, context.config, presented);

  if (caller.kind === "refused") {
    context.log(`auth: exchange ${UNIDENTIFIED}: refused, ${describeRefusal(caller.reason)}`);
    // One status and one sentence for every refusal, unlike the permission
    // calls: this is the sign-in path, and the caller is whoever reached the
    // endpoint. Saying which check failed would say whether an account exists.
    throw new GrpcStatusError(
      GRPC_UNAUTHENTICATED,
      "the token presented for exchange was not accepted",
    );
  }

  const minted = mintToken(caller.user, context.keys.signingKey, context.config);
  context.log(
    `auth: exchange ${caller.user.username}: issued a token until ` +
      `${new Date(minted.claims.exp * 1000).toISOString()}`,
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
 * `RebacApi/CreateResource`: loreserver saying a repository now exists.
 *
 * It arrives just after `nlhub project create` asked for the repository, so the
 * project is already recorded and its owner already granted — this is a second
 * telling of something Hub caused. It is recorded in the log and nothing is
 * written, because a project row needs a creator and this call names nobody.
 *
 * A resource Hub has never heard of is logged and otherwise let be: it is a
 * repository created by something other than Hub, and inventing a project for
 * it would be inventing an owner.
 */
function createResource(context: AuthorizationContext, call: GrpcCall): Buffer {
  const request = decodeCreateResourceRequest(call.message);
  const projectId = projectIdFromResourceId(request.resourceId);
  const project = projectId === undefined ? undefined : findProject(context.database, projectId);

  context.log(
    `auth: create resource ${request.resourceId} "${request.resourceName}": ${
      project === undefined ? "no project of this Hub" : `the project ${project.name}`
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
    context.log(`auth: delete resource ${who} ${request.resourceId}: no project of this Hub`);
    return EMPTY_MESSAGE;
  }
  const level =
    caller.kind === "identified"
      ? accessLevel(context.database, project.id, caller.user.id)
      : undefined;
  if (level !== "owner") {
    context.log(
      `auth: delete resource ${who} ${request.resourceId}: kept, ${
        caller.kind === "identified" ? "the caller does not own it" : describeRefusal(caller.reason)
      }`,
    );
    return EMPTY_MESSAGE;
  }

  forgetProject(context.database, project.id);
  context.log(
    `auth: delete resource ${who} ${request.resourceId}: forgot the project ${project.name}`,
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
    methods: authorizationMethods(options),
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.portOption === undefined ? {} : { portOption: options.portOption }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}

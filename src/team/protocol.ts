/**
 * The Team protocol: what a Studio installation and this server say to each other.
 *
 * Until now the whole conversation was authentication and a repository address.
 * Everything an author actually did happened in Lore, and everything this server
 * knew was answered one request at a time to whoever asked. That is enough for a
 * list of projects and nothing else: work somebody else did arrives when a person
 * reopens a screen, and there is nowhere below a project to put anything.
 *
 * So there is a second thing on the wire now, and it is a **session** rather than
 * a request. One connection per Studio installation, authenticated once, over
 * which either side may speak: Studio makes calls and subscribes to topics, and
 * this server answers calls and pushes events on those topics. The five things
 * the REST API already answers stay exactly where they are, for the Studio builds
 * that only know about those.
 *
 * Three properties of this file are load-bearing, and each is written here rather
 * than in the code that uses it so that both halves of the conversation read the
 * same page:
 *
 *  1. **It is additive.** The discovery document's `protocol` does not move. An
 *     older Studio never opens this socket, never hears of these methods, and
 *     loses nothing. What tells a newer Studio that this is here is a capability
 *     name, matched literally, exactly as the existing five are.
 *
 *  2. **Anchors are opaque.** A comment is attached to a place in a project, and
 *     that place is named in Studio's terms: a document inside the project, an
 *     element inside the document. This server stores those strings, indexes on
 *     them and hands them back. It never parses one, never checks one against a
 *     repository, and never needs upgrading because Studio started anchoring to
 *     a new kind of thing. That is the same bargain the project reader already
 *     makes, where what it cannot read is reported as unknown rather than as an
 *     error.
 *
 *  3. **A method is one place, not eight.** The names below are the whole of the
 *     surface. Adding one is a module in src/team/methods and a caller in Studio.
 *     It is not a route, a capability constant, an IPC event, a preload line and
 *     a renderer type, which is the cost that kept this protocol at five verbs
 *     for as long as it was five verbs.
 *
 * The twin of this file is `src/shared/types/team.ts` in Studio. They are two
 * copies on purpose, because the repositories release separately and neither
 * depends on the other, and `src/team/conformance.test.ts` pins the shapes both
 * sides agree on so that a change to one is a failing test rather than a bad
 * afternoon.
 */

/** Where the socket is, on the same TLS listener everything else is on. */
export const TEAM_SOCKET_PATH = "/api/team/v1/socket";

/**
 * What this file's shapes are, as a whole.
 *
 * Separate from the discovery document's `protocol`, and it moves for the same
 * reason: when a field an older client relies on stops meaning what it meant. A
 * client that finds a number it does not know closes the socket and says so,
 * rather than guessing at frames.
 */
export const TEAM_PROTOCOL_VERSION = 1;

/**
 * How often each side expects to hear anything at all.
 *
 * Sent in the opening frame rather than agreed in advance, so a deployment behind
 * something with a shorter idle timeout can be told to speak sooner without every
 * client being rebuilt. The pings themselves are WebSocket control frames rather
 * than messages here: keeping a connection alive is the transport's job.
 */
export const TEAM_HEARTBEAT_MS = 30_000;

/** The names Studio matches literally to know what a session offers. */
export type TeamCapability =
  /** This socket exists at all. Everything below implies it. */
  | "session"
  /** Threads and comments anchored in a project. */
  | "comments";

/* ------------------------------------------------------------------ frames */

/**
 * What arrives first, before anything is asked.
 *
 * The account is in it because a session is a person rather than a token: Studio
 * shows whose comments are its own, and reading that off a JWT it holds would
 * mean Studio parsing tokens it is otherwise told to treat as opaque.
 */
export interface TeamHelloFrame {
  readonly t: "hello";
  readonly protocol: number;
  readonly server: { readonly name: string; readonly version: string };
  /** This connection's own id, for a log line on either side. */
  readonly session: string;
  readonly account: TeamAccount;
  /** Every method this build answers, so a client can check before it asks. */
  readonly methods: readonly string[];
  readonly capabilities: readonly TeamCapability[];
  /** The server's clock, so a client can say "two minutes ago" without trusting its own. */
  readonly serverTime: number;
  readonly heartbeatMs: number;
}

/** Who is on the other end. */
export interface TeamAccount {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  /** Whether this account may open the operator's page. Not a permission over any project. */
  readonly operator: boolean;
}

/** A question, which will be answered exactly once. */
export interface TeamCallFrame {
  readonly t: "call";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** The answer to one call. */
export interface TeamResultFrame {
  readonly t: "result";
  readonly id: number;
  readonly value: unknown;
}

/**
 * Why a call was not answered.
 *
 * Coded rather than worded, as every refusal crossing this boundary is: the
 * sentence a person reads is written in Studio, in their language. The message is
 * for a log, and it is in English on purpose.
 */
export interface TeamErrorFrame {
  readonly t: "error";
  readonly id: number;
  readonly code: TeamErrorCode;
  readonly message: string;
}

/** Ask to be told when something changes. */
export interface TeamSubscribeFrame {
  readonly t: "subscribe";
  readonly id: number;
  readonly topic: string;
}

/** Stop being told. */
export interface TeamUnsubscribeFrame {
  readonly t: "unsubscribe";
  readonly id: number;
  readonly topic: string;
}

/**
 * A subscription is in place, and from which point.
 *
 * `seq` is the last event this server published on that topic before the
 * subscription existed. A client compares it with the last number it saw, and
 * **anything other than exactly that number means read the collection again**.
 * Not merely a higher one: the sequences live in the server's memory, so a
 * restart takes them back to nought, and a restart is a missed event.
 *
 * Events are never replayed. This server keeps no log of them, and a client that
 * re-reads is a client that is correct rather than one that is fast.
 */
export interface TeamSubscribedFrame {
  readonly t: "subscribed";
  readonly id: number;
  readonly topic: string;
  readonly seq: number;
}

/** Something changed on a topic somebody is listening to. */
export interface TeamEventFrame {
  readonly t: "event";
  readonly topic: string;
  readonly seq: number;
  readonly payload: unknown;
}

/**
 * This server is about to close, and here is why.
 *
 * Sent as a message rather than left to the close code, because a close code is
 * two bytes and a number: what a person is shown when their session ends has to
 * distinguish a token that expired from a server that is shutting down, and only
 * one of those is worth reconnecting into straight away.
 */
export interface TeamByeFrame {
  readonly t: "bye";
  readonly code: TeamErrorCode;
  readonly message: string;
}

export type TeamServerFrame =
  | TeamHelloFrame
  | TeamResultFrame
  | TeamErrorFrame
  | TeamSubscribedFrame
  | TeamEventFrame
  | TeamByeFrame;

export type TeamClientFrame = TeamCallFrame | TeamSubscribeFrame | TeamUnsubscribeFrame;

/**
 * Every way a call can fail.
 *
 * Small on purpose. A client that cannot act on the difference between two codes
 * will print whichever it got, so a code exists only where Studio does something
 * different because of it.
 */
export type TeamErrorCode =
  /** This build has no such method. A client that read `methods` will not see this. */
  | "unknown-method"
  /** The parameters were not the shape the method takes. */
  | "bad-params"
  /** The thing named is not on this server. */
  | "not-found"
  /** The caller may not do that. */
  | "refused"
  /** It would collide with something already there. */
  | "conflict"
  /** True now and possibly not in a moment: a repository this server has not read yet. */
  | "unavailable"
  /** The token that opened this session is no longer good. Reconnecting will not help. */
  | "unauthenticated"
  /** Something nobody planned for. */
  | "internal";

/* ------------------------------------------------------------------ topics */

/** The list of projects on this server changed. */
export const TOPIC_PROJECTS = "projects";

/** The accounts on this server changed. */
export const TOPIC_MEMBERS = "members";

/** One project's row, or what this server has read out of its repository. */
export function projectTopic(projectId: string): string {
  return `project:${projectId}`;
}

/** The threads anchored anywhere in one project. */
export function projectThreadsTopic(projectId: string): string {
  return `project:${projectId}/threads`;
}

/* ----------------------------------------------------------------- anchors */

/**
 * Where in a project something is attached.
 *
 * **Every field is a string this server does not read.** `document` is a path as
 * Studio writes it, `element` is Studio's id for a row or an element inside that
 * document, and `revision` is what the repository was at when somebody wrote the
 * comment. This server stores them, indexes on the first two and compares them
 * for equality. It does not open the document, does not check the revision, and
 * does not refuse an anchor whose shape it has never seen.
 *
 * That is what keeps the two halves independently releasable. A Studio that
 * begins anchoring to something new needs nothing here at all.
 */
export interface TeamAnchor {
  readonly document: string;
  readonly element?: string;
  readonly revision?: string;
}

/** The most a stored anchor field may be, so one cannot become somewhere to put a file. */
export const ANCHOR_FIELD_LIMIT = 512;

/** The most a comment may be. Long enough for a paragraph of notes, short of a document. */
export const COMMENT_BODY_LIMIT = 8 * 1024;

/**
 * The most a suggestion may carry.
 *
 * Larger than a comment because it holds a replacement for whatever it is
 * anchored to rather than a sentence about it, and bounded for the same reason
 * everything else here is: this is a database row, not a repository.
 */
export const SUGGESTION_LIMIT = 64 * 1024;

/* ----------------------------------------------------- what methods answer */

/** A conversation attached to one anchor. */
export interface TeamThread {
  readonly id: string;
  readonly project: string;
  readonly anchor: TeamAnchor;
  readonly kind: TeamThreadKind;
  readonly status: TeamThreadStatus;
  /** The account that opened it, by user id. Match it against the members list for a name. */
  readonly createdBy: string;
  readonly createdAt: number;
  /** When anything in it last changed, so a list can be ordered by what is live. */
  readonly updatedAt: number;
  readonly resolvedBy?: string;
  readonly resolvedAt?: number;
  /** How many comments it holds, withdrawn ones included: a list shows a count, not bodies. */
  readonly comments: number;
  /** The first comment, which is what a list of threads shows. */
  readonly opening?: TeamComment;
}

/**
 * What kind of thing a thread is.
 *
 * A suggestion is a comment that also carries a proposed replacement for what it
 * is anchored to. The replacement is opaque here, so the difference this server
 * knows about is one word and the difference Studio knows about is a button.
 */
export type TeamThreadKind = "comment" | "suggestion";

export type TeamThreadStatus = "open" | "resolved";

/** One thing somebody said. */
export interface TeamComment {
  readonly id: string;
  readonly thread: string;
  /** The account that wrote it, by user id. */
  readonly author: string;
  readonly body: string;
  /**
   * What this comment proposes, as Studio encoded it.
   *
   * A string this server never looks inside, for the reason set out on
   * {@link TeamAnchor}. Absent on an ordinary comment.
   */
  readonly suggestion?: string;
  readonly createdAt: number;
  readonly editedAt?: number;
  /**
   * When it was withdrawn, if it was.
   *
   * A withdrawn comment keeps its row and loses its body. The shape of a
   * conversation is part of what the remaining comments mean, since a reply to
   * nothing reads as a reply to the comment above it, so the row stays and says
   * that it is gone.
   */
  readonly deletedAt?: number;
}

/** What happened on a project's threads topic. */
export type TeamThreadEvent =
  | { readonly kind: "thread-created"; readonly thread: TeamThread }
  | { readonly kind: "thread-updated"; readonly thread: TeamThread }
  | { readonly kind: "comment-created"; readonly thread: string; readonly comment: TeamComment }
  | { readonly kind: "comment-updated"; readonly thread: string; readonly comment: TeamComment };

/** What happened on the projects topic. */
export type TeamProjectsEvent =
  | { readonly kind: "project-created"; readonly project: string }
  | { readonly kind: "project-forgotten"; readonly project: string }
  /** This server read a repository again, so what it says about it may have changed. */
  | { readonly kind: "project-read"; readonly project: string };

/* -------------------------------------------------------- method names */

/**
 * Every method, as one list.
 *
 * Written out rather than derived, because this is the half of the contract a
 * client checks against: a name here that no module answers is a name Studio
 * would call and be refused, and the registry asserts the two agree at startup.
 */
export const TEAM_METHODS = {
  /** Every project on this server, the same list the REST route answers. */
  projectsList: "projects.list",
  /** One project, and what has been read out of its repository. */
  projectsGet: "projects.get",
  /** Every account, as a name beside a piece of work. */
  membersList: "members.list",
  /** The threads anchored in one project, newest activity first. */
  threadsList: "threads.list",
  /** One thread and every comment in it. */
  threadsGet: "threads.get",
  /** Open a thread on an anchor, with its first comment. */
  threadsCreate: "threads.create",
  /** Add a comment to a thread. */
  threadsReply: "threads.reply",
  /** Mark a thread resolved, or open it again. */
  threadsResolve: "threads.resolve",
  /** Change the wording of one's own comment. */
  commentsEdit: "comments.edit",
  /** Withdraw one's own comment, leaving the shape of the conversation. */
  commentsDelete: "comments.delete",
} as const;

export type TeamMethodName = (typeof TEAM_METHODS)[keyof typeof TEAM_METHODS];

/**
 * Every panel the interface draws, as lines of styled text.
 *
 * A panel is built here and rendered somewhere else, so what it says can be
 * read without a terminal, and so that the number of lines it will occupy is
 * known before anything is drawn. Nothing in this file decides anything: it is
 * handed a view and it words it.
 */
import {
  ellipsis,
  fileSize,
  groupDigits,
  plural,
  relativeTime,
  shortDate,
  shortFingerprint,
  shortUptime,
  clockTime,
  uptime,
  UNKNOWN,
  withoutScheme,
  wrapText,
} from "./format.js";
import type { HubView, ProjectView, UserView } from "./hubview.js";
import type { Surface } from "./state.js";
import { SURFACES, SURFACE_NAMES } from "./state.js";
import { BLANK, span, type Line, type Span } from "./text.js";

/** Below this the header drops the part that is nice to have. */
const HEADER_WIDE_FROM = 90;

/** Below this a field's value is the short spelling of itself. */
const FIELD_WIDE_FROM = 90;

/** Below this a list drops the columns that are not the point of it. */
const LIST_WIDE_FROM = 62;

/** Below this the settings surface drops the notes beside a value. */
const SETTINGS_WIDE_FROM = 74;

/** How far a field's label is padded before its value. */
const FIELD_PAD = 13;

/* ---------------------------------------------------------------- chrome */

/** A section rule: the label, then a line to the right edge. */
export function section(label: string, width: number): Line {
  const rule = Math.max(0, width - label.length - 3);
  return span(` ${label} ${"─".repeat(rule)}`, { dim: true });
}

/** A labelled value, with the labels of a block lining up. */
export function field(label: string, value: string | Line, pad = FIELD_PAD): Line {
  const head: Span = { text: ` ${label.padEnd(pad, " ")}`, dim: true };
  return typeof value === "string" ? [head, { text: value }] : [head, ...value];
}

/** What the server is doing, in one word. */
function healthWord(view: HubView): string {
  if (!view.server.running) {
    return "stopped";
  }
  return view.server.healthy ? "healthy" : "not healthy";
}

export function headerLine(view: HubView, width: number): Line {
  const left = `nlhub ${view.hubVersion}`;
  const wide = width >= HEADER_WIDE_FROM;
  const right = `loreserver ${view.server.version} · ${healthWord(view)}${
    wide ? ` · ${plural(view.projects.length, "project")}` : ""
  }`;
  // The path gives way first. What this line is for is whether loreserver is
  // up, and a storage root deep enough to push that off the edge is on the
  // settings surface in full.
  const room = Math.max(0, width - left.length - right.length - 4);
  const middle = room === 0 ? "" : `  ${ellipsis(view.root, room)}`;
  const gap = Math.max(1, width - left.length - middle.length - right.length - 1);
  return [
    { text: left, bold: true },
    { text: middle, dim: true },
    { text: " ".repeat(gap) },
    { text: right, color: view.server.running && view.server.healthy ? "green" : "red" },
  ];
}

/**
 * The keys each surface answers to.
 *
 * Every one of them ends in the way out, because a person who cannot tell
 * where they are can at least tell how to leave.
 */
const KEYS: Readonly<Record<Surface, string>> = {
  dashboard: " 1-4 surface · i invite · n new project · l log · ? help · q quit",
  users: " ↑↓ move · ⏎ open · i invite · d disable · x revoke tokens · l log · q quit",
  projects: " ↑↓ move · ⏎ open · n new · g grant · r revoke · l log · q quit",
  settings: " ↑↓ move · ⏎ change · l log · q quit  (· cannot be changed here)",
};

export function footerLine(surface: Surface, width: number): Line {
  return span(ellipsis(KEYS[surface], width), { dim: true });
}

/** The rail down the left, one line per surface, each twelve columns wide. */
export function railLines(active: Surface): Line[] {
  return SURFACES.map((surface) =>
    span(` ${SURFACE_NAMES[surface].padEnd(11, " ")}`, {
      ...(surface === active ? { inverse: true, bold: true } : {}),
    }),
  );
}

/** The rail across the top, which is what a narrow terminal gets instead. */
export function railStrip(active: Surface): Line {
  return SURFACES.map((surface) => ({
    text: ` ${SURFACE_NAMES[surface]} `,
    ...(surface === active ? { inverse: true } : {}),
  }));
}

/* ------------------------------------------------------------- dashboard */

const QUICK: ReadonlyArray<readonly [string, string]> = [
  ["i", "invite somebody"],
  ["n", "new project"],
  ["c", "connection details"],
  ["l", "follow the log"],
  ["k", "rotate signing key"],
  ["R", "restart loreserver"],
];

function quickLines(width: number): Line[] {
  const columns = width >= 100 ? 3 : width >= 66 ? 2 : 1;
  const cell = Math.max(4, Math.floor((width - 1) / columns));
  const lines: Line[] = [];
  for (let index = 0; index < QUICK.length; index += columns) {
    const parts: Span[] = [{ text: " " }];
    for (const [key, what] of QUICK.slice(index, index + columns)) {
      parts.push({ text: key, bold: true, color: "cyan" });
      parts.push({ text: ` ${what}`.padEnd(cell - 1, " ") });
    }
    lines.push(parts);
  }
  return lines;
}

/** One decision out of the log, as one line. */
function auditLine(entry: HubView["audit"][number], width: number): Line {
  const verdict = `${entry.allowed ? "allowed" : "refused"} (${entry.detail})`;
  const text = ` ${clockTime(entry.at)}  ${entry.username.padEnd(5, " ")} ${entry.resource.padEnd(
    11,
    " ",
  )} ${verdict}`;
  return span(ellipsis(text, width), entry.allowed ? { dim: true } : { color: "red" });
}

/** The log, newest first, which is the order somebody looking for a refusal reads in. */
function newestFirst(view: HubView): HubView["audit"] {
  return [...view.audit].sort((left, right) => right.at - left.at);
}

/** What loreserver is doing, as much of it as Hub can see from outside. */
function serverValue(view: HubView, wide: boolean): string {
  const { server } = view;
  const parts = [`${server.version} ${server.running ? "running" : "stopped"}`];
  if (wide && server.pid !== undefined) {
    parts.push(`pid ${server.pid}`);
  }
  if (server.startedAt !== undefined) {
    const since = view.now - server.startedAt;
    parts.push(`up ${wide ? uptime(since) : shortUptime(since)}`);
  }
  if (wide && server.startedAt !== undefined) {
    parts.push(plural(server.restarts, "restart"));
  }
  return parts.join(" · ");
}

function healthValue(view: HubView, wide: boolean): string {
  const state = view.server.healthy ? "ok" : "failing";
  const checked = relativeTime(view.server.healthCheckedAt, view.now);
  const port = view.reach.loopback.find((listener) => listener.what === "health")?.port;
  if (!wide || port === undefined) {
    return `${state} · ${checked}`;
  }
  return `${state} · :${port}/health_check · ${checked}`;
}

/** When anybody last pushed to any project. */
function lastPush(view: HubView): string {
  const times = view.projects
    .map((project) => project.history.lastAt)
    .filter((at): at is number => at !== undefined);
  if (times.length === 0) {
    return view.projects.every((project) => project.history.revisions === 0) ? "never" : UNKNOWN;

  }
  return relativeTime(Math.max(...times), view.now);
}

/** What the projects add up to, counting only the ones Hub has a size for. */
function projectBytes(view: HubView): number | undefined {
  const sizes = view.projects
    .map((project) => project.history.bytes)
    .filter((bytes): bytes is number => bytes !== undefined);
  return sizes.length === 0 ? undefined : sizes.reduce((total, bytes) => total + bytes, 0);
}

export function dashboardLines(view: HubView, width: number, height: number): Line[] {
  const wide = width >= FIELD_WIDE_FROM;
  const { server, reach } = view;
  const disabled = view.users.filter((user) => user.disabled).length;

  const lines: Line[] = [
    section("server", width),
    field("loreserver", serverValue(view, wide)),
    field("health", healthValue(view, wide)),
    field(
      "storage",
      wide
        ? `${fileSize(server.storageBytes)} · ${plural(view.projects.length, "repository", "repositories")} · ${server.storageRoot}`
        : `${fileSize(server.storageBytes)} · ${view.projects.length} repos`,
    ),
    field("sign-in", wide ? reach.signIn : withoutScheme(reach.signIn)),
    field("data", wide ? reach.data : withoutScheme(reach.data)),
    field("authority", shortFingerprint(reach.fingerprint)),

    BLANK,
    section("at a glance", width),
    field(
      "people",
      wide
        ? `${plural(view.users.length, "account")} · ${disabled} disabled · ${plural(view.invitesLive, "invite")} live`
        : `${view.users.length} · ${disabled} disabled · ${plural(view.invitesLive, "invite")}`,
    ),
    field(
      "projects",
      wide
        ? `${plural(view.projects.length, "project")} · ${fileSize(projectBytes(view))} · last push ${lastPush(view)}`
        : `${view.projects.length} · last push ${lastPush(view)}`,
    ),

    BLANK,
    section("quick", width),
    ...quickLines(width),

    BLANK,
    section("recent", width),
  ];

  // Whatever is left over goes to the log, and it is the only part that
  // shrinks: an operator who cannot see the health of the server has lost the
  // point of the screen, and one who can see two decisions instead of four has
  // not.
  const room = Math.max(0, height - lines.length);
  const recent = newestFirst(view).slice(0, Math.min(room, wide ? 4 : 2));
  if (recent.length === 0 && room > 0) {
    lines.push(span("  nothing yet", { dim: true }));
    return lines;
  }
  return [...lines, ...recent.map((entry) => auditLine(entry, width))];
}

/* ----------------------------------------------------------------- users */

function userState(user: UserView): string {
  return user.disabled ? "disabled" : "active";
}

export function userListHeader(width: number): Line {
  const wide = width >= LIST_WIDE_FROM;
  return span(
    wide ? " who      name             role     state      projects  last seen" : " who      state     seen",
    { dim: true },
  );
}

export function userRow(user: UserView, view: HubView, width: number, selected: boolean): Line {
  const wide = width >= LIST_WIDE_FROM;
  const seen = relativeTime(user.lastSeenAt, view.now);
  const text = wide
    ? ` ${user.username.padEnd(8, " ")} ${user.displayName.padEnd(16, " ")} ${user.role.padEnd(
        8,
        " ",
      )} ${userState(user).padEnd(10, " ")} ${String(user.projects.length).padStart(8, " ")}  ${seen}`
    : ` ${user.username.padEnd(8, " ")} ${userState(user).padEnd(9, " ")} ${seen}`;
  return span(ellipsis(text, width).padEnd(width, " "), {
    ...(selected ? { inverse: true } : {}),
    ...(user.disabled ? { color: "red" } : {}),
  });
}

export function userDetailLines(
  user: UserView,
  view: HubView,
  width: number,
  heading: boolean,
): Line[] {
  const named = user.email === undefined ? user.displayName : `${user.displayName} · ${user.email}`;
  const lines: Line[] = [];
  if (heading) {
    lines.push(span(user.username, { bold: true }));
  }
  lines.push(span(` ${named}`, { dim: true }));
  lines.push(BLANK);
  lines.push([
    { text: " state    ", dim: true },
    { text: userState(user), color: user.disabled ? "red" : "green" },
    ...(user.serviceAccount ? [{ text: " · service account", dim: true }] : []),
  ]);
  lines.push(field("role", user.role, 9));
  lines.push(field("joined", shortDate(user.createdAt), 9));
  lines.push(field("seen", relativeTime(user.lastSeenAt, view.now), 9));
  lines.push(
    field(
      "tokens",
      user.tokensInvalidatedAt === undefined
        ? UNKNOWN
        : `last invalidated ${relativeTime(user.tokensInvalidatedAt, view.now)}`,
      9,
    ),
  );
  lines.push(BLANK);
  lines.push(span(" projects", { dim: true }));
  if (user.projects.length === 0) {
    lines.push(span("   none", { dim: true }));
  } else {
    const pad = Math.max(...user.projects.map((project) => project.name.length)) + 2;
    for (const project of user.projects) {
      lines.push(span(ellipsis(`   ${project.name.padEnd(pad, " ")} ${project.level}`, width)));
    }
  }
  return lines;
}

/* -------------------------------------------------------------- projects */

/**
 * A project's size, and when it was last touched.
 *
 * A project with no revisions has neither, and that is not the same as Hub
 * failing to work them out: a dash is nothing, the word unknown is a gap.
 */
function projectSize(project: ProjectView): string {
  if (project.history.bytes !== undefined) {
    return fileSize(project.history.bytes);
  }
  return project.history.revisions === 0 ? "—" : UNKNOWN;
}

/** The revision count, or a mark for a count nobody has taken. */
function revisionCount(project: ProjectView): string {
  return project.history.revisions === undefined ? "?" : String(project.history.revisions);
}

function projectLast(project: ProjectView, view: HubView): string {
  if (project.history.lastAt !== undefined) {
    return relativeTime(project.history.lastAt, view.now);
  }
  return project.history.revisions === 0 ? "never" : UNKNOWN;
}

export function projectListHeader(width: number): Line {
  const wide = width >= LIST_WIDE_FROM;
  return span(
    wide
      ? " name          owner   people   revs   size      last activity"
      : " name          revs   size",
    { dim: true },
  );
}

export function projectRow(
  project: ProjectView,
  view: HubView,
  width: number,
  selected: boolean,
): Line {
  const wide = width >= LIST_WIDE_FROM;
  const revisions = revisionCount(project);
  const text = wide
    ? ` ${project.name.padEnd(13, " ")} ${project.owner.padEnd(7, " ")} ${String(
        project.access.length,
      ).padStart(6, " ")}  ${revisions.padStart(5, " ")}   ${projectSize(project).padEnd(
        9,
        " ",
      )} ${projectLast(project, view)}`
    : ` ${project.name.padEnd(13, " ")} ${revisions.padStart(4, " ")}   ${projectSize(project)}`;
  return span(ellipsis(text, width).padEnd(width, " "), selected ? { inverse: true } : {});
}

/** What the revision history says, which does not depend on Studio at all. */
function historyLines(project: ProjectView, view: HubView, width: number): Line[] {
  const { history } = project;
  const parts = [
    history.revisions === undefined ? UNKNOWN : plural(history.revisions, "revision"),
  ];
  if (history.branch !== undefined) {
    parts.push(history.branch);
  }
  if (history.bytes !== undefined) {
    parts.push(fileSize(history.bytes));
  }
  const lines: Line[] = [[{ text: " T0  ", dim: true }, { text: parts.join(" · ") }]];
  if (history.lastAt === undefined) {
    lines.push(
      span(`     ${history.revisions === 0 ? "nothing pushed yet" : UNKNOWN}`, { dim: true }),
    );
    return lines;
  }
  const who = history.lastBy ?? UNKNOWN;
  const message = history.lastMessage ?? "";
  lines.push(
    span(
      ellipsis(`     ${relativeTime(history.lastAt, view.now)}  ${who}  ${message}`.trimEnd(), width),
      { dim: true },
    ),
  );
  return lines;
}

/** What the project file says, or the word unknown and the reason for it. */
function fileLines(project: ProjectView, width: number): Line[] {
  const { file } = project;
  if (!file.readable) {
    return [
      [
        { text: " T1  ", dim: true },
        { text: UNKNOWN, color: "yellow" },
      ],
      ...(file.reason === undefined
        ? []
        : wrapText(file.reason, Math.max(1, width - 5)).map((text) =>
            span(`     ${text}`, { dim: true }),
          )),
    ];
  }
  const stage =
    file.stageWidth === undefined || file.stageHeight === undefined
      ? UNKNOWN
      : `${file.stageWidth}×${file.stageHeight}`;
  const lines: Line[] = [
    [
      { text: " T1  ", dim: true },
      { text: `${file.title ?? UNKNOWN} · ${stage}` },
    ],
    span(
      `     ${plural(file.scenes ?? 0, "scene")} · ${
        file.assets === undefined ? UNKNOWN : plural(file.assets, "asset")
      } · ${fileSize(file.assetBytes)}`,
      { dim: true },
    ),
  ];
  const kinds = file.assetsByKind ?? [];
  if (kinds.length > 0) {
    lines.push(
      span(
        ellipsis(
          `     ${kinds.map((kind) => `${kind.kind} ${groupDigits(kind.count)}`).join(" · ")}`,
          width,
        ),
        { dim: true },
      ),
    );
  }
  return lines;
}

export function projectDetailLines(
  project: ProjectView,
  view: HubView,
  width: number,
  heading: boolean,
): Line[] {
  const lines: Line[] = [];
  if (heading) {
    lines.push(span(project.name, { bold: true }));
  }
  lines.push(
    span(` owned by ${project.owner} · created ${shortDate(project.createdAt)}`, { dim: true }),
  );
  if (project.description !== "") {
    lines.push(span(ellipsis(` ${project.description}`, width), { dim: true }));
  }
  lines.push(BLANK);
  lines.push(...historyLines(project, view, width));
  lines.push(BLANK);
  lines.push(...fileLines(project, width));
  lines.push(BLANK);
  lines.push(span(" access", { dim: true }));
  if (project.access.length === 0) {
    lines.push(span("     nobody", { dim: true }));
  } else {
    const pad = Math.max(...project.access.map((grant) => grant.username.length)) + 2;
    for (const grant of project.access) {
      lines.push(span(ellipsis(`     ${grant.username.padEnd(pad, " ")}${grant.level}`, width)));
    }
  }
  return lines;
}

/* -------------------------------------------------------------- settings */

/**
 * The settings surface, and where each row ended up.
 *
 * The rows come back with their line numbers because the surface scrolls to
 * the selected one, and a group heading is a line that belongs to no row.
 */
export function settingsLines(
  view: HubView,
  width: number,
  selection: number,
): { lines: Line[]; rowLines: number[] } {
  const wide = width >= SETTINGS_WIDE_FROM;
  const lines: Line[] = [];
  const rowLines: number[] = [];
  let group = "";
  for (const [index, setting] of view.settings.entries()) {
    if (setting.group !== group) {
      group = setting.group;
      if (lines.length > 0) {
        lines.push(BLANK);
      }
      lines.push(section(group, width));
    }
    // The mark in the first column is the whole of what says a row cannot be
    // changed here; the footer says what the mark means.
    const lock = setting.editable ? " " : "·";
    const note = wide && setting.restartRequired === true ? "   (restart)" : "";
    const label = setting.label.padEnd(wide ? 19 : 17, " ");
    rowLines.push(lines.length);
    lines.push(
      span(ellipsis(` ${lock} ${label} ${setting.value}${note}`, width).padEnd(width, " "), {
        ...(index === selection ? { inverse: true } : {}),
      }),
    );
  }
  return { lines, rowLines };
}

/**
 * Scroll a block so that one line of it is on screen.
 *
 * It scrolls no further than it has to, so that a surface which fits does not
 * move when the selection does.
 */
export function scrollTo(lines: readonly Line[], height: number, focus: number): Line[] {
  if (lines.length <= height) {
    return [...lines];
  }
  const first = Math.min(Math.max(0, focus - height + 2), lines.length - height);
  return lines.slice(first, first + height);
}

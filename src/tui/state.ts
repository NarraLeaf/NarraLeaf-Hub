/**
 * What the interface is showing, and what a key does to it.
 *
 * The state is a plain value and the reducer is a pure function of it, so the
 * screen that follows any sequence of keys can be drawn and looked at without
 * a terminal. Nothing here performs anything: a key that changes something
 * asks for an {@link Action}, and the host carries it out through the same
 * operations the commands use.
 */
import type { HubView } from "./hubview.js";

/** The size of the terminal, in cells. */
export interface TuiSize {
  readonly columns: number;
  readonly rows: number;
}

/** The four things the interface can be looking at. */
export type Surface = "dashboard" | "users" | "projects" | "settings";

/** The surfaces in the order the rail lists them, which is what 1 to 4 pick. */
export const SURFACES: readonly Surface[] = ["dashboard", "users", "projects", "settings"];

/** What the rail calls each surface. */
export const SURFACE_NAMES: Readonly<Record<Surface, string>> = {
  dashboard: "Dashboard",
  users: "Users",
  projects: "Projects",
  settings: "Settings",
};

/**
 * A window drawn over the surface.
 *
 * The log is one of these rather than a fifth surface: it is read while
 * something else is being looked at, and a surface would mean leaving that
 * behind to see it.
 */
export type Overlay =
  | { readonly kind: "project-detail"; readonly project: string }
  | { readonly kind: "user-detail"; readonly username: string }
  | { readonly kind: "revoke-tokens"; readonly username: string }
  | { readonly kind: "edit-setting"; readonly index: number }
  | { readonly kind: "connection" }
  | { readonly kind: "help" }
  | { readonly kind: "log" };

export interface TuiState {
  readonly surface: Surface;
  readonly selection: number;
  readonly overlays: readonly Overlay[];
}

/** What the interface opens on. */
export const INITIAL_STATE: TuiState = { surface: "dashboard", selection: 0, overlays: [] };

/**
 * Something the interface was asked to do that only the host can do.
 *
 * Every one of these has a command that does the same thing, and the host
 * carries it out by calling what that command calls. The interface knows the
 * name of the request and nothing about how it is met, which is what keeps it
 * from becoming a second implementation of the rules.
 */
export type Action =
  | { readonly kind: "quit" }
  | { readonly kind: "refresh" }
  | { readonly kind: "create-invite" }
  | { readonly kind: "rotate-key" }
  | { readonly kind: "restart-loreserver" }
  | { readonly kind: "new-project" }
  | { readonly kind: "grant-access"; readonly project: string }
  | { readonly kind: "revoke-access"; readonly project: string }
  | { readonly kind: "set-user-disabled"; readonly username: string; readonly disabled: boolean }
  | { readonly kind: "revoke-tokens"; readonly username: string }
  | { readonly kind: "set-setting"; readonly index: number; readonly value: string };

/**
 * One key press, as much of it as this interface cares about.
 *
 * Ink's own key type has a field for every key a terminal can send; this is
 * the handful that mean anything here, so that the reducer can be driven from
 * a test without one.
 */
export interface KeyPress {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly tab?: boolean;
  readonly shift?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

/**
 * The state, plus the text being typed into the setting editor.
 *
 * The draft is not part of {@link TuiState} because a drawn screen is
 * described by the state alone; the editor window draws the setting's stored
 * value until somebody types over it.
 */
export interface Session {
  readonly state: TuiState;
  readonly draft: string;
}

export interface Step {
  readonly session: Session;
  readonly action?: Action;
}

/** The window on top, which is the one keys reach. */
export function topOverlay(state: TuiState): Overlay | undefined {
  return state.overlays[state.overlays.length - 1];
}

/** How many rows the surface has to move a selection through. */
export function rowCount(surface: Surface, view: HubView): number {
  switch (surface) {
    case "users":
      return view.users.length;
    case "projects":
      return view.projects.length;
    case "settings":
      return view.settings.length;
    case "dashboard":
      return 0;
  }
}

function clamp(value: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.min(Math.max(value, 0), count - 1);
}

function withState(session: Session, state: TuiState): Step {
  return { session: { ...session, state } };
}

function push(session: Session, overlay: Overlay, draft?: string): Step {
  return {
    session: {
      state: { ...session.state, overlays: [...session.state.overlays, overlay] },
      draft: draft ?? session.draft,
    },
  };
}

function pop(session: Session): Step {
  return withState(session, { ...session.state, overlays: session.state.overlays.slice(0, -1) });
}

function move(session: Session, by: number, view: HubView): Step {
  const count = rowCount(session.state.surface, view);
  return withState(session, {
    ...session.state,
    selection: clamp(session.state.selection + by, count),
  });
}

function goTo(session: Session, surface: Surface): Step {
  // The overlays go with the surface they were opened from. A window about a
  // project left open over the users list would be answering a question
  // nobody is looking at any more.
  return withState(session, { surface, selection: 0, overlays: [] });
}

/**
 * Keys handled while the setting editor is open.
 *
 * Everything printable goes into the draft, including the letters that are
 * commands anywhere else — a `q` typed into a duration must not quit.
 */
function editSetting(session: Session, key: KeyPress, index: number): Step {
  if (key.escape === true) {
    return pop(session);
  }
  if (key.return === true) {
    return {
      session: { state: { ...session.state, overlays: session.state.overlays.slice(0, -1) }, draft: "" },
      action: { kind: "set-setting", index, value: session.draft },
    };
  }
  if (key.backspace === true || key.delete === true) {
    return { session: { ...session, draft: [...session.draft].slice(0, -1).join("") } };
  }
  if (key.ctrl === true || key.meta === true || key.input === "") {
    return { session };
  }
  return { session: { ...session, draft: session.draft + key.input } };
}

/** Keys handled while a confirmation is open: agree, or leave. */
function confirm(session: Session, key: KeyPress, action: Action): Step {
  if (key.escape === true) {
    return pop(session);
  }
  if (key.return === true) {
    return { session: { ...session, state: { ...session.state, overlays: session.state.overlays.slice(0, -1) } }, action };
  }
  return { session };
}

/**
 * Work out what one key press does.
 *
 * The view is needed to know how far a selection may move and who a key would
 * act on; nothing is read from it that is not on screen.
 */
export function reduce(session: Session, key: KeyPress, view: HubView): Step {
  const { state } = session;
  const top = topOverlay(state);

  if (top?.kind === "edit-setting") {
    return editSetting(session, key, top.index);
  }
  if (top?.kind === "revoke-tokens") {
    return confirm(session, key, { kind: "revoke-tokens", username: top.username });
  }

  if (key.escape === true) {
    return state.overlays.length === 0 ? { session } : pop(session);
  }
  if (key.upArrow === true) {
    return move(session, -1, view);
  }
  if (key.downArrow === true) {
    return move(session, 1, view);
  }
  if (key.tab === true) {
    const index = SURFACES.indexOf(state.surface);
    const next = SURFACES[(index + (key.shift === true ? SURFACES.length - 1 : 1)) % SURFACES.length];
    return next === undefined ? { session } : goTo(session, next);
  }
  if (key.return === true) {
    return open(session, view);
  }

  switch (key.input) {
    case "q":
      return { session, action: { kind: "quit" } };
    case "1":
    case "2":
    case "3":
    case "4": {
      const surface = SURFACES[Number(key.input) - 1];
      return surface === undefined ? { session } : goTo(session, surface);
    }
    case "j":
      return move(session, 1, view);
    case "?":
      return push(session, { kind: "help" });
    case "l":
      return push(session, { kind: "log" });
    case "c":
      return push(session, { kind: "connection" });
    case "i":
      return { session, action: { kind: "create-invite" } };
    case "n":
      return { session, action: { kind: "new-project" } };
    case "r":
      return asked(session, withProject(state, view, "revoke-access"));
    case "g":
      return asked(session, withProject(state, view, "grant-access"));
    case "R":
      return { session, action: { kind: "restart-loreserver" } };
    case "d":
      return asked(session, disableAction(state, view));
    case "x": {
      const user = selectedUser(state, view);
      return user === undefined ? { session } : push(session, { kind: "revoke-tokens", username: user.username });
    }
    case "k":
      // The one key that means two things, and it has to: `k` moves a
      // selection up wherever there is one, and the dashboard — which has no
      // selection — is where the quick action that rotates a key is offered.
      return state.surface === "dashboard"
        ? { session, action: { kind: "rotate-key" } }
        : move(session, -1, view);
    default:
      return { session };
  }
}

/** A step that asks for an action, or one that does nothing when there is none. */
function asked(session: Session, action: Action | undefined): Step {
  return action === undefined ? { session } : { session, action };
}

function selectedUser(state: TuiState, view: HubView): HubView["users"][number] | undefined {
  return state.surface === "users" ? view.users[state.selection] : undefined;
}

function selectedProject(state: TuiState, view: HubView): HubView["projects"][number] | undefined {
  return state.surface === "projects" ? view.projects[state.selection] : undefined;
}

function disableAction(state: TuiState, view: HubView): Action | undefined {
  const user = selectedUser(state, view);
  if (user === undefined) {
    return undefined;
  }
  return { kind: "set-user-disabled", username: user.username, disabled: !user.disabled };
}

function withProject(
  state: TuiState,
  view: HubView,
  kind: "grant-access" | "revoke-access",
): Action | undefined {
  const project = selectedProject(state, view);
  return project === undefined ? undefined : { kind, project: project.name };
}

/** What return does on each surface. */
function open(session: Session, view: HubView): Step {
  const { state } = session;
  if (state.surface === "users") {
    const user = view.users[state.selection];
    return user === undefined ? { session } : push(session, { kind: "user-detail", username: user.username });
  }
  if (state.surface === "projects") {
    const project = view.projects[state.selection];
    return project === undefined
      ? { session }
      : push(session, { kind: "project-detail", project: project.name });
  }
  if (state.surface === "settings") {
    const setting = view.settings[state.selection];
    // A row Hub cannot write opens nothing. An editor over a value that would
    // be thrown away is worse than no editor, because it looks like it worked.
    if (setting === undefined || !setting.editable) {
      return { session };
    }
    return push(session, { kind: "edit-setting", index: state.selection }, setting.value);
  }
  return { session };
}

/**
 * The lists an operator picks from.
 *
 * Choosing rather than typing is the point. An account name and a project name
 * both already exist and are both already on the screen the picker opens over;
 * asking somebody to type one is asking them to misspell it, and it was the
 * reason three keys used to answer with the command to go and run instead of
 * doing the thing they were named after.
 *
 * Both sides of a picker read the list from here — the code that draws it and
 * the code that decides what a keypress chose. Two lists built separately would
 * agree until one of them was filtered.
 */
import type { HubView } from "./hubview.js";

/** One row of a picker: what it is, and what is true of it now. */
export interface Choice {
  readonly name: string;
  /** The state a reader needs in order to choose, never a restatement of the name. */
  readonly note: string;
}

/** How far a grant goes. Owner is not here: it comes from creating a project. */
export const LEVELS: readonly Choice[] = [
  { name: "read", note: "open it and follow it" },
  { name: "write", note: "and push to it" },
];

function projectOf(view: HubView, project: string): HubView["projects"][number] | undefined {
  return view.projects.find((candidate) => candidate.name === project);
}

/**
 * Everybody who could be given access to a project, and where they stand.
 *
 * The owner is listed and cannot be chosen: leaving them out invites the
 * question of where they went, and a list that answers it is shorter than the
 * support conversation.
 */
export function accountsFor(view: HubView, project: string): Choice[] {
  const record = projectOf(view, project);
  if (record === undefined) {
    return [];
  }
  return view.users.map((user) => {
    const grant = record.access.find((entry) => entry.username === user.username);
    const note =
      grant === undefined
        ? user.disabled
          ? "no access, and disabled"
          : "no access"
        : grant.level === "owner"
          ? "owns it"
          : `can ${grant.level}`;
    return { name: user.username, note };
  });
}

/** Whether a name in {@link accountsFor} is one a grant can be given to. */
export function canBeGranted(view: HubView, project: string, username: string): boolean {
  const record = projectOf(view, project);
  const grant = record?.access.find((entry) => entry.username === username);
  return grant?.level !== "owner";
}

/**
 * The people whose access to a project can be taken away.
 *
 * The owner is not among them. Taking a project from the person it belongs to
 * would leave it reachable by nobody, and nothing in Hub hands it on.
 */
export function holdersOf(view: HubView, project: string): Choice[] {
  const record = projectOf(view, project);
  if (record === undefined) {
    return [];
  }
  return record.access
    .filter((entry) => entry.level !== "owner")
    .map((entry) => ({ name: entry.username, note: `can ${entry.level}` }));
}

/** Every project, and what the named account may do to each. */
export function projectsFor(view: HubView, username: string): Choice[] {
  return view.projects.map((project) => {
    const grant = project.access.find((entry) => entry.username === username);
    const note =
      grant === undefined ? "no access" : grant.level === "owner" ? "owns it" : `can ${grant.level}`;
    return { name: project.name, note };
  });
}

/** Keep a picker's cursor on a row that exists, however the list has changed. */
export function clamp(choice: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(Math.max(choice, 0), length - 1);
}

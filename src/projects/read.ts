/**
 * Reading one project: its revision history, and the file inside it.
 *
 * Everything here happens against Hub's own checkout of the repository — see
 * ./cache.ts for why there is one at all, which is the single rule this whole
 * feature is shaped by. The checkout is the only path a Lore call is given.
 *
 * Nothing raises. A repository that cannot be reached, a checkout that cannot
 * be made, a revision that cannot be walked: each of them answers with a
 * history Hub did not count and a file it could not read, plus a sentence
 * saying which. That is what keeps a loreserver that is down or a Studio that
 * is newer costing freshness rather than costing the screen.
 */
import {
  closeStore,
  closeTree,
  listTreeChildren,
  loadTree,
  NODE_DIRECTORY,
  NODE_FILE,
  openStore,
  readAddress,
  releaseRepository,
  revisionDetails,
  revisionHistory,
  type RevisionDetails,
  type StoreHandle,
  type TreeHandle,
} from "../lore/verbs.js";
import { ensureCheckout, offlineGlobals, onlineGlobals, type CheckoutOptions } from "./cache.js";
import { readProjectFile, revisionSizes, type RevisionFile, type RevisionSource } from "./content.js";

import type { LoreGlobals } from "../lore/call.js";
import type { ProjectFileView, RevisionView } from "../tui/hubview.js";

/** What one read of a project produced. */
export interface ProjectReading {
  readonly history: RevisionView;
  readonly file: ProjectFileView;
  /** True when this read cloned the project rather than syncing it. */
  readonly cloned: boolean;
}

export type ReadProjectOptions = CheckoutOptions;

/**
 * How many tree entries a walk will visit.
 *
 * A project with more than this in one revision is not one this can describe
 * in the time a screen refresh has, and stopping is better than a total that
 * grew for a minute. The counts then read as unknown.
 */
const TREE_ENTRY_LIMIT = 200_000;

/** Raised inside the walk, and turned into a sentence before it leaves. */
class TreeTooLargeError extends Error {
  constructor() {
    super(
      `this revision holds more than ${TREE_ENTRY_LIMIT.toLocaleString("en-US")} entries, which is more than Hub will walk`,
    );
    this.name = "TreeTooLargeError";
  }
}

/** Read everything Hub can say about one project. Never throws. */
export async function readProject(options: ReadProjectOptions): Promise<ProjectReading> {
  try {
    return await read(options);
  } catch (error) {
    return {
      history: {},
      file: { readable: false, reason: unreachable(error) },
      cloned: false,
    };
  }
}

async function read(options: ReadProjectOptions): Promise<ProjectReading> {
  const checkout = await ensureCheckout(options);
  const local = offlineGlobals(checkout.path);
  const online = onlineGlobals(checkout.path);

  try {
    const { branch } = checkout;
    const revisions = await revisionHistory(local);
    const tip = revisions.at(-1);

    if (tip === undefined) {
      // Zero rather than absent, and the two are not the same thing on screen:
      // this is a project nobody has pushed to, which Hub knows, rather than a
      // count Hub did not take.
      return {
        history: { revisions: 0, ...(branch === undefined ? {} : { branch }) },
        file: {
          readable: false,
          reason: "nothing has been pushed to this project yet",
        },
        cloned: checkout.cloned,
      };
    }

    // A revision with no metadata Hub could read still counts as a revision:
    // the count and the branch above it are true either way, and the who and
    // the when are absent rather than the whole history being lost.
    const details: RevisionDetails = await revisionDetails(local, tip.revision).catch(() => ({}));
    const history: RevisionView = {
      revisions: revisions.length,
      ...(branch === undefined ? {} : { branch }),
      ...(details.timestamp === undefined ? {} : { lastAt: details.timestamp }),
      ...(details.author === undefined ? {} : { lastBy: details.author }),
      ...(details.message === undefined ? {} : { lastMessage: details.message }),
    };

    const walked = await walkRevision(online, {
      path: checkout.path,
      remoteUrl: checkout.remoteUrl,
      repository: options.projectId,
      revision: tip.revision,
    });

    return {
      history: { ...history, ...(walked.bytes === undefined ? {} : { bytes: walked.bytes }) },
      file: walked.file,
      cloned: checkout.cloned,
    };
  } finally {
    // Whatever happened, let go of the checkout: on Windows a file the library
    // still holds cannot be deleted, and this directory is one somebody is
    // entitled to delete at any moment.
    await releaseRepository(local).catch(() => undefined);
  }
}

/** A revision walked, measured and read. */
interface WalkedRevision {
  /**
   * What the revision holds, absent when it could not be walked.
   *
   * Absent rather than nought, which the interface draws differently and
   * rightly: nought is a revision with nothing in it, and a size Hub failed to
   * measure must not read as a project somebody emptied.
   */
  readonly bytes?: number;
  readonly file: ProjectFileView;
}

async function walkRevision(
  globals: LoreGlobals,
  target: { path: string; remoteUrl: string; repository: string; revision: string },
): Promise<WalkedRevision> {
  // The remote URL is what makes a checkout holding nothing answer for every
  // file in the revision: without it, a blob that is not already here is a get
  // that fails rather than one that fetches.
  let store: StoreHandle | undefined;
  let tree: TreeHandle | undefined;
  try {
    store = await openStore(globals, { path: target.path, remoteUrl: target.remoteUrl });
    tree = await loadTree(globals, store, target.repository, target.revision);
    const files = await collectFiles(globals, tree);

    const source = revisionSource(globals, store, target.repository, files);
    const file = await readProjectFile(source);
    return { bytes: revisionSizes(source).totalBytes, file };
  } catch (error) {
    return { file: { readable: false, reason: unreadableRevision(error) } };
  } finally {
    if (tree !== undefined) {
      await closeTree(globals, tree).catch(() => undefined);
    }
    if (store !== undefined) {
      await closeStore(globals, store).catch(() => undefined);
    }
  }
}

/** One tree entry, kept with the address its bytes are at. */
interface TreeEntry extends RevisionFile {
  readonly address: { hash: string; context: string };
}

/**
 * Every file in a revision, with its size and where its bytes are.
 *
 * One call per directory, breadth first. Each entry already carries its own
 * address, so nothing here needs a lookup per file — which is what makes
 * measuring a revision cost the shape of the tree rather than the size of it.
 */
async function collectFiles(globals: LoreGlobals, tree: TreeHandle): Promise<TreeEntry[]> {
  const files: TreeEntry[] = [];
  const pending: Array<{ nodeId: number; prefix: string }> = [{ nodeId: 0, prefix: "" }];
  let visited = 0;

  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined) {
      break;
    }
    for (const child of await listTreeChildren(globals, tree, next.nodeId)) {
      visited += 1;
      if (visited > TREE_ENTRY_LIMIT) {
        throw new TreeTooLargeError();
      }
      const path = next.prefix === "" ? child.name : `${next.prefix}/${child.name}`;
      if (child.kind === NODE_DIRECTORY) {
        pending.push({ nodeId: child.nodeId, prefix: path });
        continue;
      }
      if (child.kind === NODE_FILE) {
        files.push({ path, size: child.size, address: child.address });
      }
      // A link is neither walked nor counted: it has no bytes of its own, and
      // following one inside a revision would count something twice.
    }
  }

  return files;
}

/** The revision as ./content.ts wants it: entries, and a way to fetch one. */
function revisionSource(
  globals: LoreGlobals,
  store: StoreHandle,
  repository: string,
  files: readonly TreeEntry[],
): RevisionSource {
  const addresses = new Map(files.map((file) => [file.path, file.address]));
  return {
    files,
    async read(file) {
      const address = addresses.get(file.path);
      if (address === undefined) {
        throw new Error(`${file.path} is not in this revision`);
      }
      return readAddress(globals, store, repository, address);
    },
  };
}

/** The sentence for a project whose repository Hub could not get to. */
function unreachable(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `this project's repository could not be read: ${detail}`;
}

/** The sentence for a revision Hub reached but could not walk. */
function unreadableRevision(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `the latest revision of this project could not be read: ${detail}`;
}

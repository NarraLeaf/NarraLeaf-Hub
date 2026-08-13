/**
 * Where identity keeps its two pieces of state under the storage root.
 *
 * Both are derived from the same root the rest of Team uses, so that copying
 * one directory copies a whole Team — including the accounts and the signing
 * keys, which is worth knowing before choosing where to put it.
 */
import { join, resolve } from "node:path";

/** Absolute paths belonging to one storage root. */
export interface IdentityLayout {
  /** The storage root itself, absolute. */
  readonly root: string;
  /** The SQLite file holding users and invites. */
  readonly databasePath: string;
  /** Directory holding the RSA private keys tokens are signed with. */
  readonly keysDir: string;
}

/**
 * Derive the identity paths from a storage root.
 *
 * The root is resolved here for the same reason the loreserver layout resolves
 * it: a relative path on a command line has to become absolute once, in one
 * place, rather than twice against two working directories.
 */
export function identityLayout(root: string): IdentityLayout {
  const absoluteRoot = resolve(root);
  return {
    root: absoluteRoot,
    databasePath: join(absoluteRoot, "team.db"),
    keysDir: join(absoluteRoot, "keys"),
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

/**
 * A source of throwaway storage roots, cleaned up after each test.
 *
 * Removal is allowed to fail: on Windows a file that a test left open cannot
 * be deleted, and a temporary directory outliving a test run is not a reason
 * to fail one.
 */
export function useTemporaryRoots(prefix: string): () => Promise<string> {
  const roots: string[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root === undefined) {
        continue;
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        // Left behind for the operating system to clear.
      }
    }
  });

  return async () => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  };
}

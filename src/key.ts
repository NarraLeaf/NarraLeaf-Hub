/**
 * The `key` commands: see the signing keys, and add one.
 *
 * Rotating is safe at any moment. The new key signs from then on, the old one
 * stays published and keeps verifying the tokens it signed, and no client is
 * asked to do anything. Taking a key out of the JWKS is a separate act, because
 * doing it too soon invalidates tokens that have not expired yet.
 */
import type { WriteText } from "./cli.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";

export interface KeyOptions {
  readonly root: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Print every key Team holds. Returns the process exit code. */
export async function keyList(
  options: KeyOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  try {
    const keys = await KeyStore.open(layout.keysDir);
    const signing = keys.signingKey;
    for (const key of keys.all) {
      const state = key.retired ? "retired" : key.kid === signing.kid ? "signing" : "verifying";
      stdout(`${state.padEnd(9)}  ${key.kid}\n`);
    }
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

/** Generate a key and sign with it from now on. Returns the process exit code. */
export async function keyRotate(
  options: KeyOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  try {
    const keys = await KeyStore.open(layout.keysDir);
    const key = await keys.rotate();
    stdout(`signing with ${key.kid}\n`);
    stdout(
      `${keys.published.length} key(s) are published; tokens signed by any of them still ` +
        "verify.\n",
    );
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }
}

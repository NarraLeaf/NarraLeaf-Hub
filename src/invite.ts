/**
 * The `invite create` command.
 *
 * The code is printed once, here, and cannot be printed again: only its hash is
 * stored. That is the whole point of the command, so the output says so.
 */
import type { WriteText } from "./cli.js";
import { openMigratedDatabase } from "./identity/database.js";
import { createInvite } from "./identity/invites.js";
import { identityLayout } from "./identity/layout.js";

export interface InviteCreateOptions {
  readonly root: string;
  readonly role: string;
  readonly lifetimeMs: number;
}

/** How an invitation is shown, wherever one is printed. */
export function renderInvite(
  code: string,
  role: string,
  expiresAt: number,
  root: string,
): string {
  return [
    "",
    `    ${code}`,
    "",
    `role ${role}, expires ${new Date(expiresAt).toISOString()}`,
    "It is shown here and nowhere else; Team keeps only a hash of it.",
    `Redeem it with: nlteam user create <username> --root ${root} --invite ${code}`,
    "",
  ].join("\n");
}

/** Make one invitation. Returns the process exit code. */
export async function inviteCreate(
  options: InviteCreateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const { code, invite } = createInvite(database, {
      role: options.role,
      lifetimeMs: options.lifetimeMs,
    });
    stdout("invite code:\n");
    stdout(renderInvite(code, invite.role, invite.expiresAt, layout.root));
    return 0;
  } catch (error) {
    stderr(`nlteam: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

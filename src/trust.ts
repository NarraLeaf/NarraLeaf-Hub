/**
 * The `trust` command: what this Hub's certificate authority is, and how a
 * machine comes to believe it.
 *
 * Running it with no arguments changes nothing at all. That is the point of it:
 * the fingerprint it prints is what a person compares against the one the
 * server printed, over a channel that is not the one being secured — a phone
 * call, a chat window, a piece of paper. Installing before comparing would make
 * the comparison a formality performed after the decision.
 */
import type { WriteText } from "./cli.js";
import { identityLayout } from "./identity/layout.js";
import { readAuthority } from "./tls/authority.js";
import { installPlan, removePlan, runTrustCommand, type TrustPlan } from "./tls/trust.js";

export interface TrustOptions {
  readonly root: string;
  /** Put the authority into this account's trust store. */
  readonly install?: boolean;
  /** Take it out again. */
  readonly remove?: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The block naming the authority and its fingerprint, which every run prints. */
function renderAuthority(path: string, fingerprint: string, subject: string): string {
  return [
    "This Hub's certificate authority:",
    `  ${path}`,
    `  ${subject.split("\n").join(", ")}`,
    `  SHA-256  ${fingerprint}`,
    "",
    "",
  ].join("\n");
}

/** Print a plan a person has to carry out themselves. */
function renderPlan(plan: TrustPlan, whatFor: string): string {
  return [`To ${whatFor}, on this machine:`, "", `  ${plan.command}`, "", ""].join("\n");
}

/**
 * Show the fingerprint, install the authority, or remove it.
 *
 * Returns the process exit code.
 */
export async function trust(
  options: TrustOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  try {
    const authority = await readAuthority(layout.root);
    const removing = options.remove === true;
    const plan = removing
      ? removePlan(authority.layout.caCertPath, authority.certificate)
      : installPlan(authority.layout.caCertPath);

    // Printed first in every case, including the two that go on to change
    // something: a person watching an install still wants to see what was
    // installed, and the line stays in the terminal's scrollback afterwards.
    stdout(
      renderAuthority(
        authority.layout.caCertPath,
        authority.fingerprint256,
        authority.certificate.subject,
      ),
    );

    if (options.install !== true && !removing) {
      stdout(
        "Compare that fingerprint with the one printed by the Hub you mean to reach,\n" +
          "over something other than the connection you are about to trust.\n\n",
      );
      stdout(renderPlan(plan, "trust it"));
      if (plan.support === "runs-here") {
        stdout("nlhub trust --install runs that for you.\n");
      }
      stdout("Nothing has been changed.\n");
      return 0;
    }

    if (plan.support !== "runs-here") {
      // Linux, and anything else. There is no per-user store other programs
      // read, so saying "installed" would be a claim about a machine-wide
      // change this command did not make and could not make without root.
      stdout(renderPlan(plan, removing ? "stop trusting it" : "trust it"));
      stderr(
        "nlhub: there is no per-user trust store on this platform, so nothing was changed. " +
          "Run the two commands above.\n",
      );
      return 1;
    }

    if (plan.interaction !== undefined) {
      // Before the command starts, not after: a dialog that opened behind
      // another window is indistinguishable from a program that has stopped
      // responding, and a person who has not been warned will kill it.
      stdout(`${plan.interaction}\n\n`);
    }
    stdout(`Running: ${plan.command}\n`);

    const outcome = await runTrustCommand(plan.argv);
    if (outcome.output !== "") {
      stdout(`${outcome.output}\n`);
    }
    if (outcome.code !== 0) {
      stderr(
        `nlhub: that command ended with status ${outcome.code}, so the trust store was ` +
          "probably not changed.\n",
      );
      return 1;
    }

    stdout(
      removing
        ? "\nThis account no longer trusts that authority.\n"
        : "\nThis account now trusts certificates issued by that authority.\n",
    );
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  }
}

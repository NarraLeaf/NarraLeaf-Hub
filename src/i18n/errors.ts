/**
 * Saying what went wrong, in the language of whoever asked.
 *
 * Every error Team raises already carries a sentence, written where the rule it
 * broke is written. Those sentences are English, and they stay English: they go
 * into the log, into what the commands print, and into what a developer reads
 * in a stack trace, none of which is a place a language is chosen. What is
 * translated is what a browser is shown, and that translation happens here —
 * once, at the edge, rather than by threading a language through every module
 * that can fail.
 *
 * The rule for adding one: an error belongs here when an operator can cause it
 * from the interface and can do something about it. Everything else falls
 * through to its English `message`, which is the honest answer — a sentence in
 * the wrong language beats a sentence that says nothing, and a page that
 * invented "something went wrong" would be hiding the one detail worth having.
 *
 * Server-only. The browser half never imports it: doing so would pull the whole
 * identity layer, and the database with it, into a bundle meant for a page.
 */
import { GrpcCallError, GrpcConnectionError } from "../grpc/client.js";
import { NoSigningKeyError } from "../identity/keys.js";
import {
  InvalidSettingError,
  MAXIMUM_TOKEN_LIFETIME_SECONDS,
  MINIMUM_TOKEN_LIFETIME_SECONDS,
} from "../identity/settings.js";
import { DisabledAccountError } from "../identity/tokens.js";
import { UnknownUserError } from "../identity/users.js";
import {
  InvalidProjectNameError,
  ProjectNameTakenError,
  UnknownProjectError,
} from "../projects/registry.js";
import type { Messages } from "./messages.js";

/**
 * What to show for something that was raised while carrying out an action.
 *
 * The settings row is named by its label as the view sends it, so the sentence
 * about a lifetime that will not fit names the row a person was looking at
 * rather than the column it is stored in.
 */
export function describeError(error: unknown, messages: Messages): string {
  const m = messages.error;

  if (error instanceof UnknownUserError) {
    return m.unknownUser({ username: error.username });
  }
  if (error instanceof UnknownProjectError) {
    return m.unknownProject({ project: error.reference });
  }
  if (error instanceof InvalidProjectNameError) {
    return m.invalidProjectName({ project: error.projectName });
  }
  if (error instanceof ProjectNameTakenError) {
    return m.projectNameTaken({ project: error.projectName });
  }
  if (error instanceof DisabledAccountError) {
    return m.accountDisabled({ username: error.username });
  }
  if (error instanceof NoSigningKeyError) {
    return m.noSigningKey({ directory: error.keysDir });
  }
  if (error instanceof InvalidSettingError) {
    return m.invalidSetting({
      label: labelOf(error.key, messages),
      value: error.value,
      minimum: String(MINIMUM_TOKEN_LIFETIME_SECONDS),
      maximum: String(MAXIMUM_TOKEN_LIFETIME_SECONDS),
    });
  }
  if (error instanceof GrpcConnectionError) {
    // Which of the two matters to an operator: a loreserver that never answered
    // is a process to go and look at, and one that answered no is a thing about
    // the request. The sentence for the first says that nothing was created,
    // because the interface has already withdrawn the row it wrote.
    return m.loreserverSilent;
  }
  if (error instanceof GrpcCallError) {
    return m.loreserverRefused({
      detail: error.statusMessage === "" ? String(error.status) : error.statusMessage,
    });
  }

  return error instanceof Error ? error.message : String(error);
}

/**
 * A settings key as the interface writes it.
 *
 * `InvalidSettingError` names the column — `signInTokenLifetimeSeconds` — and
 * nobody reading a page has seen that word. The view's label is what they have
 * seen, so it is what the sentence says.
 */
function labelOf(key: string, messages: Messages): string {
  const label = key.startsWith("signIn") ? "sign-in token" : "repository token";
  return messages.page.settings.rowNames[label] ?? label;
}

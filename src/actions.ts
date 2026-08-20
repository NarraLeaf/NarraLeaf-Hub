/**
 * Carrying out the things an interface asks for.
 *
 * There are two interfaces now — the terminal one and the web one — and there
 * is one of this. Everything either of them can do arrives here as an
 * {@link Action} and leaves as the sentence to show for it, so that a rule
 * about what happens when an account is disabled, or in what order a project is
 * created, is written once and read by both.
 *
 * The sentences matter as much as the effects. Each one says how far the thing
 * that just happened reaches — "from their next request", "tokens already
 * minted keep the lifetime they were given" — because that is the part an
 * operator gets wrong, and it is the same wording the command of the same name
 * prints.
 *
 * They are also the sentences a browser is shown, and a browser says which
 * language it wants, so every one of them comes from a catalogue rather than
 * from a literal here. English unless a caller says otherwise: the terminal
 * interface asks for nothing and gets exactly the words it always had.
 */
import { describeDuration } from "./duration.js";
import { en } from "./i18n/en.js";
import { identityConfig } from "./identity/config.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import {
  lifetimeUnder,
  SERVER_NAME_KEY,
  setServerName,
  setTokenLifetimes,
  SIGN_IN_LIFETIME_KEY,
  storedTokenLifetimes,
} from "./identity/settings.js";
import { mintToken } from "./identity/tokens.js";
import { defaultPasswordHasher } from "./identity/passwords.js";
import {
  ADMIN_ROLE,
  createUser,
  DEFAULT_ROLE,
  disableUser,
  enableUser,
  requireUser,
  revokeUserTokens,
} from "./identity/users.js";
import {
  createProject,
  forgetProject,
  newProjectId,
} from "./projects/registry.js";
import { loreserverUrl, repositoryCreate } from "./projects/repository.js";
import type { Messages } from "./i18n/messages.js";
import type { Action } from "./tui/state.js";
import { settingKeyOf, settingRows, type ViewContext } from "./view.js";

import type { DatabaseSync } from "node:sqlite";

/** A duration written as digits and one letter, which every language accepts. */
const WRITTEN_DURATION = /^(\d+)([smhd])?$/;

/** How many seconds each letter is worth. */
const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Read a duration the way it was written on screen.
 *
 * The editor opens on the words a person reads — "30 days", "30 天", "30日" —
 * so those exact words have to be accepted back, which is why the unit words
 * come from the same catalogue that wrote them. English words and `7d` are
 * accepted whatever the language: `7d` is what every command line here takes,
 * and somebody who knows one spelling should not have to discover the other.
 */
export function readDuration(text: string, messages: Messages = en): number | string {
  const written = stripUnitWords(text.trim().toLowerCase(), messages);
  const match = WRITTEN_DURATION.exec(written);
  if (match?.[1] === undefined) {
    return messages.error.notADuration({ value: text.trim() });
  }
  const amount = Number(match[1]);
  if (amount < 1) {
    return messages.error.durationTooSmall;
  }
  return amount * (UNIT_SECONDS[match[2] ?? "s"] ?? 1);
}

/**
 * Turn whatever unit was written into its letter, and drop the spaces.
 *
 * This language's words are tried before English's, so that a language whose
 * word for something happens to contain an English one cannot be read as the
 * English. Within each, longest first, for the same reason.
 */
function stripUnitWords(text: string, messages: Messages): string {
  for (const [word, letter] of [...messages.format.durationWords, ...en.format.durationWords]) {
    if (text.endsWith(word)) {
      return `${text.slice(0, -word.length).trim()}${letter}`.replace(/\s+/g, "");
    }
  }
  return text.replace(/\s+/g, "");
}

/** What the interface is told after somebody's tokens were refused. */
function revokedMessage(
  database: DatabaseSync,
  username: string,
  messages: Messages,
): string {
  const lifetimes = storedTokenLifetimes(database);
  // The same two facts `nlteam user revoke-tokens` prints, for the same reason:
  // "every token" is read as including a session somebody has open, and it
  // does not.
  return messages.action.tokensRevoked({
    username,
    lifetime: describeDuration(lifetimes.repositoryTokenLifetimeSeconds, messages),
  });
}

/** Change one setting, and say what it now is. */
function writeSetting(
  context: ViewContext,
  index: number,
  value: string,
  messages: Messages,
): string {
  const row = settingRows(context)[index];
  const key = row === undefined ? undefined : settingKeyOf(row.label);
  if (row === undefined || !row.editable || key === undefined) {
    return messages.action.settingReadOnly;
  }

  // The row is found by the label the view carries, and drawn by whatever this
  // language calls it. A row no language has a name for is named by the label,
  // which is what the page showed.
  const label = messages.page.settings.rowNames[row.label] ?? row.label;

  // Not every setting is a duration any more. The name is stored as it was
  // typed, and reading it as one would refuse every name that is not a number.
  if (key === SERVER_NAME_KEY) {
    return messages.action.settingChanged({
      label,
      value: setServerName(context.database, value),
    });
  }

  const seconds = readDuration(value, messages);
  if (typeof seconds === "string") {
    return seconds;
  }
  const lifetimes = setTokenLifetimes(
    context.database,
    key === SIGN_IN_LIFETIME_KEY
      ? { signInTokenLifetimeSeconds: seconds }
      : { repositoryTokenLifetimeSeconds: seconds },
  );
  return messages.action.settingChanged({
    label,
    value: describeDuration(lifetimeUnder(lifetimes, key), messages),
  });
}

/**
 * What one action came to.
 *
 * The sentence is what every interface shows and what the log records. The
 * secret is neither: it is a credential the action produced once — a token
 * minted for somebody to be handed — and it is answered separately precisely so
 * that the thing which logs the sentence cannot log it by accident.
 */
export interface Performed {
  readonly message: string;
  /**
   * Something to put on the screen that asked, and nowhere else.
   *
   * Not written to the log, not kept in the view, and not stored anywhere: the
   * interface that asked shows it until somebody navigates away, and a person
   * who missed it asks for another.
   */
  readonly secret?: string;
}

/** An action that said something and produced nothing to keep. */
function said(message: string): Performed {
  return { message };
}

/**
 * Carry out one thing an interface asked for.
 *
 * The one that names a command rather than doing anything needs something
 * neither interface has: a process it does not supervise. Naming the command is
 * the honest answer; a button that pretended to do it would not be.
 */
export async function perform(
  context: ViewContext,
  action: Action,
  messages: Messages = en,
): Promise<Performed> {
  const { database, root } = context;
  switch (action.kind) {
    case "rotate-key": {
      const keys = await KeyStore.open(identityLayout(root).keysDir);
      const key = await keys.rotate();
      return said(messages.action.keyRotated({ kid: key.kid, published: keys.published.length }));
    }
    case "set-user-disabled": {
      if (action.disabled) {
        disableUser(database, action.username);
        return said(messages.action.userDisabled({ username: action.username }));
      }
      enableUser(database, action.username);
      return said(messages.action.userEnabled({ username: action.username }));
    }
    case "revoke-tokens": {
      revokeUserTokens(database, action.username);
      return said(revokedMessage(database, action.username, messages));
    }
    case "set-setting":
      return said(writeSetting(context, action.index, action.value, messages));
    case "create-account": {
      // The same call `nlteam user create` makes, with the same hasher, so that
      // what a username may be, which group is the default and what happens to
      // a name already taken are answered once for both.
      const user = await createUser(database, defaultPasswordHasher(), {
        username: action.username,
        password: action.password,
        ...(action.displayName === undefined ? {} : { displayName: action.displayName }),
        ...(action.email === undefined ? {} : { email: action.email }),
        groups: [action.operator ? ADMIN_ROLE : DEFAULT_ROLE],
      });
      // The same thing the command says last, for the same reason: an account
      // nobody was given a token for reaches nothing, and that is the step it
      // is easiest to stop one short of.
      return said(
        messages.action.accountCreated({
          username: user.username,
          group: user.groups.join(", "),
        }),
      );
    }
    case "issue-token": {
      // What `nlteam token mint` mints, minus the password: whoever asked has
      // already proved who they are to this interface, and an operator who can
      // disable the account can hardly be stopped from issuing it a token.
      const user = requireUser(database, action.username);
      const keys = await KeyStore.open(identityLayout(root).keysDir);
      const config = identityConfig({ ...context.config, ...storedTokenLifetimes(database) });
      const minted = mintToken(user, keys.signingKey, config, {
        purpose: "sign-in",
        // The claim that lets the machine this is pasted into decide whether to
        // trust this server, on a token that is about to leave the building.
        ...(context.fingerprint === undefined
          ? {}
          : { authorityFingerprint: context.fingerprint }),
      });
      return {
        message: messages.action.tokenIssued({
          username: user.username,
          lifetime: describeDuration(config.signInTokenLifetimeSeconds, messages),
        }),
        // Beside the sentence rather than inside it, so that what is logged and
        // what is shown are two different strings.
        secret: minted.token,
      };
    }
    case "create-project": {
      // The same sequence `project create` runs, and for the same reason it
      // runs it in that order: the row is written first so that a repository
      // is never made without something recording who it belongs to, and it is
      // withdrawn again if loreserver refuses, so a failure leaves nothing.
      const owner = requireUser(database, action.owner);
      const keys = await KeyStore.open(identityLayout(root).keysDir);
      const config = identityConfig({ ...context.config, ...storedTokenLifetimes(database) });
      const minted = mintToken(owner, keys.signingKey, config, { purpose: "repository" });
      const project = createProject(database, {
        id: newProjectId(),
        name: action.name,
        createdBy: owner.id,
      });
      try {
        await repositoryCreate({
          url: loreserverUrl(config.dataPort),
          token: minted.token,
          id: project.id,
          name: project.name,
          description: project.description,
        });
      } catch (error) {
        forgetProject(database, project.id);
        throw error;
      }
      return said(
        messages.action.projectCreated({
          project: project.name,
          owner: owner.username,
        }),
      );
    }
    case "restart-loreserver":
      return said(messages.action.loreserverNotOurs);
    case "quit":
    case "refresh":
      // Neither reaches here: an interface acts on both itself.
      return said("");
  }
}

/**
 * The `settings` commands: show what this Hub keeps in its database, and change
 * one of them.
 *
 * The two token lifetimes were editable from the terminal interface and from
 * nowhere else, which made them the only settings a person could not change
 * over ssh, from a script, or on a machine with no terminal to draw on.
 *
 * What is shown is what is in effect, which is not the same as what is stored:
 * a setting nobody has chosen has no row at all and the default answers for it,
 * so the listing says which of the two each value is. Changing one reaches a
 * Hub that is already running, because a lifetime is read as each token is
 * minted rather than held from the moment `up` started.
 */
import type { WriteText } from "./cli.js";
import { describeDuration } from "./duration.js";
import { openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";
import {
  isSettingStored,
  lifetimeUnder,
  REPOSITORY_LIFETIME_CAUTION,
  REPOSITORY_LIFETIME_KEY,
  setTokenLifetime,
  SETTING_KEYS,
  storedTokenLifetimes,
  type SettingKey,
} from "./identity/settings.js";

export interface SettingsListOptions {
  readonly root: string;
}

export interface SettingsSetOptions {
  readonly root: string;
  readonly key: SettingKey;
  /** The new value, already read out of whatever duration was typed. */
  readonly seconds: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The widest key, so the values line up under each other. */
const KEY_WIDTH = Math.max(...SETTING_KEYS.map((key) => key.length));

/** Print every setting, its value, and where that value came from. */
export async function settingsList(
  options: SettingsListOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const lifetimes = storedTokenLifetimes(database);
    for (const key of SETTING_KEYS) {
      // The duration in the words somebody would have typed, not the seconds
      // the key names: 2592000 is correct and nobody can hold it up against
      // what they set.
      const value = describeDuration(lifetimeUnder(lifetimes, key));
      const source = isSettingStored(database, key) ? "set here" : "default";
      stdout(`${key.padEnd(KEY_WIDTH)}  ${value.padEnd(12)}  ${source}\n`);
    }
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/**
 * Change one setting, and say what it was and what it now is.
 *
 * Both numbers, because the reason somebody runs this is to make a change and
 * the thing they want to see is the change. The sentence after it is the part
 * that surprises people: a shorter lifetime does not shorten a token that has
 * already been minted, and on the repository lifetime it does not shorten a
 * connection either.
 */
export async function settingsSet(
  options: SettingsSetOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const before = lifetimeUnder(storedTokenLifetimes(database), options.key);
    const after = lifetimeUnder(
      setTokenLifetime(database, options.key, options.seconds),
      options.key,
    );

    stdout(`${options.key} is ${describeDuration(after)}, and was ${describeDuration(before)}\n`);
    stdout("Tokens already minted keep the lifetime they were given.\n");
    if (options.key === REPOSITORY_LIFETIME_KEY) {
      stdout(`${REPOSITORY_LIFETIME_CAUTION}\n`);
    }
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

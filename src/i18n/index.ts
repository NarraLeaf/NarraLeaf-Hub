/**
 * One way in for both halves: give it a locale, get the language.
 *
 * Every catalogue is bundled rather than fetched. On the server that is the
 * only thing it could be — the executable carries its own pages and its own
 * version, and a language it had to read from disk would be the one thing about
 * it that could go missing. In the browser it is a decision: all three
 * languages are a few kilobytes, and having them all means switching one is a
 * redraw rather than a page load with a spinner in the middle of somebody's
 * unsaved form.
 */
import { en } from "./en.js";
import { ja } from "./ja.js";
import type { Messages } from "./messages.js";
import { FALLBACK_LOCALE, type Locale } from "./locales.js";
import { zh } from "./zh.js";

const CATALOGUES: Readonly<Record<Locale, Messages>> = { en, zh, ja };

/** The language of a locale, or English when it names none. */
export function messagesFor(locale: Locale | undefined): Messages {
  return CATALOGUES[locale ?? FALLBACK_LOCALE];
}

/** Every language, in the order a switcher lists them. */
export function everyLanguage(): readonly Messages[] {
  return [en, zh, ja];
}

export { en, zh, ja };
export type { Messages, DurationUnit } from "./messages.js";
export {
  FALLBACK_LOCALE,
  isLocale,
  localeOfTag,
  LOCALES,
  negotiateLocale,
  type Locale,
} from "./locales.js";

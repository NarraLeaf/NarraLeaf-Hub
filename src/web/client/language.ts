/**
 * Which language this browser is reading in.
 *
 * Three sources, in this order: what somebody chose here before, what the
 * browser says it prefers, and English. The first is a choice and the second is
 * a setting, which is why a choice wins — a person reading a Japanese page on a
 * machine that came set to English chose that, and reopening the tab must not
 * undo it.
 *
 * A choice is remembered where this browser remembers things; see storage.ts
 * for why that is `localStorage` and why nothing there can throw.
 */
import { messagesFor } from "../../i18n/index.js";
import {
  FALLBACK_LOCALE,
  isLocale,
  LANGUAGE_STORAGE_KEY,
  localeOfTag,
  type Locale,
} from "../../i18n/locales.js";

import { recall, remember } from "./storage.js";

import type { Messages } from "../../i18n/messages.js";

/** The language to open in. */
export function openingLocale(): Locale {
  const remembered = recall(LANGUAGE_STORAGE_KEY);
  if (isLocale(remembered)) {
    return remembered;
  }
  // `navigator.languages` is in preference order, which is the same order an
  // `accept-language` header carries and is read in the same way: the first one
  // this interface has, and English when it has none of them.
  for (const tag of navigator.languages ?? [navigator.language]) {
    const locale = localeOfTag(tag);
    if (locale !== undefined) {
      return locale;
    }
  }
  return FALLBACK_LOCALE;
}

/**
 * Remember a choice, and tell the document what it is now in.
 *
 * The `lang` attribute is not decoration: it is what a screen reader chooses a
 * voice from, and what a browser hyphenates and picks fonts by. The shell is
 * one static document served to everybody, so this is the only place it can be
 * set truthfully.
 */
export function rememberLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  remember(LANGUAGE_STORAGE_KEY, locale);
}

/** The catalogue for a locale, which is all any screen needs of this file. */
export function languageOf(locale: Locale): Messages {
  return messagesFor(locale);
}

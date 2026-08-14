/**
 * Which languages the web interface is written in, and how one is chosen.
 *
 * Three, and English is the one everything falls back to. It is not a default
 * in the sense of being preferred: it is the language the rest of this program
 * speaks — the commands, the terminal interface, every sentence in the log —
 * so it is the one thing a page can always be drawn in, whatever a browser
 * asks for and whatever a catalogue is missing.
 *
 * Nothing here reads a file, a header parser and a list is all it is, so the
 * browser half and the server half can both import it. That matters: the page
 * decides which language to draw in, and the server decides which language to
 * answer a sentence in, and they must not decide it by different rules.
 */

/** The languages the interface is written in. */
export type Locale = "en" | "zh" | "ja";

/** Every locale, in the order a switcher lists them. */
export const LOCALES: readonly Locale[] = ["en", "zh", "ja"];

/** The one a page falls back to, and the one the rest of Team speaks. */
export const FALLBACK_LOCALE: Locale = "en";

/**
 * The header a page names its language in, and where the name of it lives.
 *
 * Here rather than beside the server's router, because both halves need the
 * same spelling and the browser half must not import anything that reaches the
 * database. It is a custom header on purpose: a form on another origin cannot
 * set one, so a request carrying it has been through this interface.
 */
export const LANGUAGE_HEADER = "x-nlteam-language";

/** Where a browser remembers the language somebody chose. */
export const LANGUAGE_STORAGE_KEY = "nlteam.language";

/** Whether some text names a language this interface has. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The locale a language tag asks for, if it is one of ours.
 *
 * Only the primary subtag is compared, so `zh-Hans-CN`, `zh-TW` and `zh` all
 * reach the same catalogue. That is a decision rather than a shortcut: this
 * interface has one Chinese, written in simplified characters, and pretending
 * to tell `zh-TW` apart from `zh-CN` while answering both with the same words
 * would be a promise it does not keep.
 */
export function localeOfTag(tag: string): Locale | undefined {
  const primary = tag.trim().toLowerCase().split("-")[0];
  return isLocale(primary) ? primary : undefined;
}

/**
 * The language an `accept-language` header asks for.
 *
 * Weighted the way the header says to weight it: every tag carries a quality
 * from 0 to 1, absent means 1, and the highest one this interface has wins. A
 * tag at `q=0` is a browser saying it does not want that language at all, so it
 * is dropped rather than ranked last.
 *
 * Anything unparseable ends at {@link FALLBACK_LOCALE}, which is also where a
 * header naming only languages Team has not been translated into ends. There is
 * no negotiation failure here and no 406: a page nobody can read is worse than
 * a page in the wrong language, and an operator can change it in the interface.
 */
export function negotiateLocale(header: string | undefined): Locale {
  if (header === undefined || header.trim() === "") {
    return FALLBACK_LOCALE;
  }

  let best: { locale: Locale; quality: number } | undefined;
  for (const part of header.split(",")) {
    const [tag, ...parameters] = part.split(";");
    if (tag === undefined) {
      continue;
    }
    const locale = tag.trim() === "*" ? FALLBACK_LOCALE : localeOfTag(tag);
    if (locale === undefined) {
      continue;
    }
    const quality = qualityOf(parameters);
    if (quality <= 0) {
      continue;
    }
    // Strictly greater, so that two tags of equal quality leave the one written
    // first in front — which is the order a browser lists its preferences in.
    if (best === undefined || quality > best.quality) {
      best = { locale, quality };
    }
  }

  return best?.locale ?? FALLBACK_LOCALE;
}

/** The `q=` of one entry, which is 1 when it does not say. */
function qualityOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [name, value] = parameter.split("=");
    if (name?.trim().toLowerCase() !== "q") {
      continue;
    }
    const quality = Number(value?.trim());
    // A q that is not a number is a malformed header, and the header says to
    // ignore what cannot be read rather than to refuse the whole request.
    return Number.isFinite(quality) ? quality : 1;
  }
  return 1;
}

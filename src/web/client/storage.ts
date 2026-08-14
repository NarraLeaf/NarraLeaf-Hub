/**
 * The few things this browser remembers between tabs.
 *
 * `localStorage` rather than a cookie, because the server does not need any of
 * it: the page names its language on every request it makes (see
 * `LANGUAGE_HEADER`) and never mentions the rail at all, and a cookie would
 * send both on requests for the script and the styles as well, which are the
 * same bytes whatever a person remembers.
 *
 * Nothing here throws. Storage is unreachable in a few real situations — a
 * browser with it switched off, a page opened in a way that makes it
 * unavailable — and losing a preference is a small thing beside taking the
 * whole interface down for the want of one.
 */

/** What was remembered under a key, or nothing. */
export function recall(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remember something, if this browser will have it. */
export function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered, which costs one preference the next time this tab opens.
  }
}

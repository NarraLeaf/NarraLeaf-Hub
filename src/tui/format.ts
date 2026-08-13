/**
 * Turning the numbers in a TeamView into the words on screen.
 *
 * Nothing here reads the clock or the machine's timezone. A relative time is
 * measured against the moment the view was gathered, and a date is written in
 * UTC, so that a drawn screen is a function of the view it was drawn from. A
 * screen that depended on either could not be compared with anything.
 */

/**
 * What is drawn where a value is missing.
 *
 * One word everywhere, because the alternative is a screen where a blank cell
 * sometimes means nothing and sometimes means Team could not work it out.
 */
export const UNKNOWN = "unknown";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
const GIBIBYTE = 1024 * MEBIBYTE;

/** Two digits, for the hours and minutes of an uptime. */
function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * How long ago something happened, measured against the view's own moment.
 *
 * A time in the future is drawn as "just now" rather than as a negative: a
 * clock a few seconds out is far more likely than a real event ahead of the
 * view, and "in -3s" helps nobody.
 */
export function relativeTime(at: number | undefined, now: number): string {
  if (at === undefined) {
    return UNKNOWN;
  }
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) {
    const seconds = Math.floor(elapsed / SECOND);
    return seconds === 0 ? "just now" : `${seconds}s ago`;
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < 2 * DAY) {
    return "yesterday";
  }
  return `${Math.floor(elapsed / DAY)}d ago`;
}

/** A date as 2026-07-02, in UTC. */
export function shortDate(at: number | undefined): string {
  if (at === undefined) {
    return UNKNOWN;
  }
  return new Date(at).toISOString().slice(0, 10);
}

/** A time of day as 14:02:11, in UTC. */
export function clockTime(at: number | undefined): string {
  if (at === undefined) {
    return UNKNOWN;
  }
  return new Date(at).toISOString().slice(11, 19);
}

/**
 * How long something has been up, as 3d 04:12.
 *
 * Days are separate from the clock part because an operator reads the days
 * first and often needs nothing else.
 */
export function uptime(milliseconds: number): string {
  const total = Math.max(0, milliseconds);
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  const clock = `${pad2(hours)}:${pad2(minutes)}`;
  return days === 0 ? clock : `${days}d ${clock}`;
}

/** The same duration with only its largest unit, for a narrow terminal. */
export function shortUptime(milliseconds: number): string {
  const total = Math.max(0, milliseconds);
  if (total >= DAY) {
    return `${Math.floor(total / DAY)}d`;
  }
  if (total >= HOUR) {
    return `${Math.floor(total / HOUR)}h`;
  }
  return `${Math.floor(total / MINUTE)}m`;
}

/**
 * A size in the units a person compares: 2.4 GB, 310 MB, 18 MB.
 *
 * The multiplier is 1024 throughout, which is what every other tool an
 * operator has open on the same directory reports.
 */
export function fileSize(bytes: number | undefined): string {
  if (bytes === undefined) {
    return UNKNOWN;
  }
  if (bytes >= GIBIBYTE) {
    return `${(bytes / GIBIBYTE).toFixed(1)} GB`;
  }
  if (bytes >= MEBIBYTE) {
    return `${Math.round(bytes / MEBIBYTE)} MB`;
  }
  if (bytes >= KIBIBYTE) {
    return `${Math.round(bytes / KIBIBYTE)} KB`;
  }
  return `${bytes} B`;
}

/** A count with its thousands separated, as 1 284. */
export function groupDigits(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** A count and the noun it counts, singular when there is one of it. */
export function plural(count: number, noun: string, plural_ = `${noun}s`): string {
  return `${groupDigits(count)} ${count === 1 ? noun : plural_}`;
}

/**
 * A host and port on their own, without the scheme.
 *
 * A narrow terminal has room for the address or for the scheme, and the
 * address is the part somebody has to type somewhere else.
 */
export function withoutScheme(url: string): string {
  const separator = url.indexOf("://");
  return separator === -1 ? url : url.slice(separator + 3);
}

/**
 * The front of a fingerprint, for a line that has no room for all of it.
 *
 * A shortened fingerprint is not one to compare, which is why the whole of it
 * is on the settings surface and in the connection window.
 */
export function shortFingerprint(fingerprint: string): string {
  const octets = fingerprint.split(":");
  // Whatever names the digest stays: a fingerprint written without one is not
  // to be handed a label here, because the label is part of what somebody
  // compares it against.
  const label = octets[0] !== undefined && octets[0].length > 2 ? `${octets.shift() ?? ""}:` : "";
  if (octets.length <= 3) {
    return fingerprint;
  }
  return `${label}${octets.slice(0, 3).join(":")}:…`;
}

/**
 * Cut text to a width, marking that it was cut.
 *
 * Cutting silently would leave a truncated address looking like a whole one.
 */
export function ellipsis(text: string, width: number): string {
  const characters = [...text];
  if (characters.length <= width) {
    return text;
  }
  if (width <= 1) {
    return "…".slice(0, Math.max(0, width));
  }
  return `${characters.slice(0, width - 1).join("")}…`;
}

/**
 * Break a sentence into lines no wider than `width`.
 *
 * Ink would wrap it, but a wrapped line inside a window is one the window was
 * not sized for, and the row it pushes off the bottom disappears without a
 * mark. Wrapping here means the caller counts the lines before drawing them.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) {
    return [];
  }
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if ([...candidate].length <= width) {
      line = candidate;
      continue;
    }
    if (line !== "") {
      lines.push(line);
    }
    line = [...word].length > width ? ellipsis(word, width) : word;
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines;
}

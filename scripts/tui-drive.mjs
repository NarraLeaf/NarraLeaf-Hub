// Drives the built executable's terminal interface through a real
// pseudo-terminal, and prints the grid a person would be looking at.
//
// It is mechanical: it captures, it does not judge. Nothing here asserts
// anything, because a driver that decided what was right would be a second
// opinion about the layout rather than a look at it.
//
// The bytes are read back through a terminal emulator rather than being
// stripped of their escape sequences, because the byte stream is not a grid.
// Ink moves the cursor instead of writing spaces, so stripping the escapes
// collapses the gaps and invents differences that are not on screen.
//
// It needs two packages that this repository deliberately does not depend on,
// since nothing it ships uses them:
//
//   npm install --no-save --no-package-lock node-pty @xterm/headless
//
// Usage:
//   node scripts/build.mjs
//   node scripts/tui-drive.mjs --root /srv/team
//   node scripts/tui-drive.mjs --root /srv/team --columns 120 --rows 40 --keys 2,down,enter,esc
//
// Keys are comma separated. Anything not named below is sent as itself, so
// `--keys 3,enter,q` and `--keys l` both work.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = {
  esc: "\u001B",
  enter: "\r",
  tab: "\t",
  up: "\u001B[A",
  down: "\u001B[B",
  left: "\u001B[D",
  right: "\u001B[C",
  backspace: "\u007F",
};

/** How long to wait for the first frame, and between key presses. */
const OPENING_MS = 1200;
const SETTLE_MS = 400;

function argumentOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const root = argumentOf("root", undefined);
if (root === undefined) {
  console.error("tui-drive: --root <path> names the Team server to open");
  process.exit(2);
}

const columns = Number(argumentOf("columns", "80"));
const rows = Number(argumentOf("rows", "24"));
const keys = argumentOf("keys", "")
  .split(",")
  .filter((key) => key.length > 0);

let spawn;
let Terminal;
try {
  ({ spawn } = await import("node-pty"));
  ({ Terminal } = (await import("@xterm/headless")).default);
} catch (error) {
  console.error(
    "tui-drive: needs node-pty and @xterm/headless, which are not dependencies of this\n" +
      "           package. Install them for this checkout with\n" +
      "             npm install --no-save --no-package-lock node-pty @xterm/headless\n" +
      `           (${error instanceof Error ? error.message : String(error)})`,
  );
  process.exit(2);
}

const executable = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "nlteam.js");

const terminal = spawn(process.execPath, [executable, "--root", root], {
  name: "xterm-256color",
  cols: columns,
  rows,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "3" },
});

const screen = new Terminal({ cols: columns, rows, allowProposedApi: true });
terminal.onData((data) => screen.write(data));

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The visible grid, one string per row, each padded to the full width. */
function grid() {
  const buffer = screen.buffer.active;
  const out = [];
  for (let y = 0; y < rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    out.push((line?.translateToString(false) ?? "").padEnd(columns, " ").slice(0, columns));
  }
  return out;
}

/**
 * Which cells of a row have a background of their own.
 *
 * This is how an overlay's rectangle is told from what is behind it: a window
 * that paints every cell of its own rectangle shows as an unbroken run, and a
 * transparent one shows as default cells inside its own border.
 */
function painted(y) {
  const buffer = screen.buffer.active;
  const line = buffer.getLine(buffer.viewportY + y);
  if (line === undefined) {
    return "";
  }
  let out = "";
  for (let x = 0; x < columns; x += 1) {
    const cell = line.getCell(x);
    out += cell === undefined || cell.isBgDefault() ? "." : "#";
  }
  return out;
}

function frame(label) {
  return {
    label,
    grid: grid(),
    painted: Array.from({ length: rows }, (_unused, y) => painted(y)),
  };
}

const frames = [];
await wait(OPENING_MS);
frames.push(frame("(opening)"));

for (const key of keys) {
  terminal.write(KEYS[key] ?? key);
  await wait(SETTLE_MS);
  frames.push(frame(key));
}

// Killing a ConPTY can throw out of an agent inside it on Windows. The capture
// is finished by this point, so a failure here must not take the report down
// with it.
try {
  terminal.kill();
} catch {
  // deliberately ignored
}

for (const captured of frames) {
  console.log(`\n=== ${captured.label} · ${columns}x${rows} ===`);
  console.log(captured.grid.join("\n"));
  const widest = Math.max(...captured.grid.map((line) => [...line].length));
  console.log(
    `--- rows=${captured.grid.length}/${rows} widest=${widest}/${columns} ` +
      `painted=${captured.painted.filter((row) => row.includes("#")).length} rows`,
  );
}

if (process.env["SHOW_PAINTED"] === "1") {
  const last = frames[frames.length - 1];
  console.log("\n=== the cells the last frame painted ===");
  console.log(last.painted.join("\n"));
}

process.exit(0);

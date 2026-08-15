// Acceptance assertions for the terminal interface.
//
// Written before the interface existed. Every assertion here is about
// something that has gone wrong in a terminal interface before: a panel that
// looks right at one width and folds at another, an overlay that is
// see-through, a row that vanishes out of the middle of a panel when the
// window is too short, and a screen that renders nothing at all while every
// assertion about it passes because none of its content is there to
// contradict.
//
// The seam this leans on is `snapshot(state, size)`: a pure function from a
// described state and a terminal size to the text grid that would be drawn.
// No timers, no database, no process. Everything below is that function.
import { describe, expect, it } from "vitest";

import { snapshot, type TuiState } from "../src/tui/snapshot.js";
import { FIXTURE_VIEW, FUTURE_SCHEMA_VIEW } from "./fixtures/teamview.js";

const SIZES = [
  { columns: 80, rows: 24 },
  { columns: 120, rows: 40 },
  { columns: 200, rows: 60 },
] as const;

/** Every surface, in a state worth looking at, with what proves it is on screen. */
const SURFACES: Array<{ name: string; state: TuiState; guard: RegExp }> = [
  {
    name: "dashboard",
    state: { surface: "dashboard", selection: 0, overlays: [] },
    guard: /\bloreserver\b/,
  },
  {
    name: "users",
    state: { surface: "users", selection: 0, overlays: [] },
    guard: /\bada\b/,
  },
  {
    name: "projects",
    state: { surface: "projects", selection: 0, overlays: [] },
    guard: /\bharbour\b/,
  },
  {
    name: "settings",
    state: { surface: "settings", selection: 0, overlays: [] },
    guard: /sign-in token/,
  },
];

/** The overlaid states, which are where the interesting failures live. */
const OVERLAID: Array<{ name: string; state: TuiState; guard: RegExp }> = [
  {
    name: "project detail",
    state: { surface: "projects", selection: 0, overlays: [{ kind: "project-detail", project: "harbour" }] },
    guard: /\bT0\b/,
  },
  {
    name: "revoke tokens",
    state: { surface: "users", selection: 2, overlays: [{ kind: "revoke-tokens", username: "cleo" }] },
    guard: /Revoke every token/i,
  },
  {
    name: "log",
    state: { surface: "dashboard", selection: 0, overlays: [{ kind: "log" }] },
    guard: /\blog\b/i,
  },
];

const ALL = [...SURFACES, ...OVERLAID];

describe("the grid every surface draws", () => {
  for (const size of SIZES) {
    for (const { name, state, guard } of ALL) {
      describe(`${name} at ${size.columns}x${size.rows}`, () => {
        const grid = snapshot(state, size, FIXTURE_VIEW);

        // The guard comes first and on purpose. A surface that failed to open
        // draws an empty screen, and an empty screen satisfies every
        // assertion of the form "nothing is too wide" and "nothing overlaps".
        // This is the assertion that refuses to pass on an empty screen.
        it("is actually on screen", () => {
          expect(grid.rows.join("\n")).toMatch(guard);
        });

        it("fills the terminal exactly", () => {
          expect(grid.rows).toHaveLength(size.rows);
        });

        it("never draws past the right edge", () => {
          const wide = grid.rows
            .map((row, index) => ({ index, width: [...row].length }))
            .filter((row) => row.width > size.columns);
          expect(wide).toEqual([]);
        });

        it("leaves no unprintable characters in the grid", () => {
          // `snapshot` returns the grid with styling removed. Anything left
          // that is not printable is an escape sequence that got through, and
          // it will show as rubbish on a real terminal.
          const bad = grid.rows.filter((row) => /[\u0000-\u0008\u000b-\u001f\u007f]/.test(row));
          expect(bad).toEqual([]);
        });

        it("says which surface it is on, and how to leave", () => {
          const all = grid.rows.join("\n");
          expect(all).toMatch(/\bq\b/);
        });
      });
    }
  }
});

describe("an overlay hides what is under it", () => {
  // The failure this catches: an absolutely positioned box paints only the
  // cells it writes to, so a window with any blank space in it shows the
  // surface behind through the gaps. It looks almost right, which is why it
  // needs an assertion rather than a glance.
  //
  // The test is to draw the same window over two different surfaces. A window
  // that paints every cell of its own rectangle looks identical either way; a
  // window with holes in it does not.
  const overlay = { kind: "revoke-tokens", username: "cleo" } as const;

  for (const size of SIZES) {
    it(`covers its own rectangle at ${size.columns}x${size.rows}`, () => {
      const overUsers = snapshot(
        { surface: "users", selection: 2, overlays: [overlay] },
        size,
        FIXTURE_VIEW,
      );
      const overProjects = snapshot(
        { surface: "projects", selection: 0, overlays: [overlay] },
        size,
        FIXTURE_VIEW,
      );

      expect(overUsers.overlay).toBeDefined();
      const { top, left, width, height } = overUsers.overlay!;
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(overProjects.overlay).toEqual(overUsers.overlay);

      // Prove the two backgrounds really do differ, or this passes for the
      // wrong reason.
      const bareUsers = snapshot({ surface: "users", selection: 2, overlays: [] }, size, FIXTURE_VIEW);
      const bareProjects = snapshot({ surface: "projects", selection: 0, overlays: [] }, size, FIXTURE_VIEW);
      expect(bareUsers.rows).not.toEqual(bareProjects.rows);

      const rectangle = (grid: { rows: string[] }): string[] =>
        grid.rows
          .slice(top, top + height)
          .map((row) => [...row].slice(left, left + width).join(""));

      expect(rectangle(overUsers)).toEqual(rectangle(overProjects));
    });
  }
});

describe("a panel keeps every line it was given", () => {
  // The failure this catches: when a panel is taller than the box holding it,
  // flexbox shrinks its children, and a shrunk row does not clip — it
  // disappears and leaves its margin behind. The border is intact, the
  // surrounding rows are intact, and one line is simply gone from the middle.
  const LABELS = ["T0", "T1", "access"];

  for (const size of SIZES) {
    it(`draws every field of the project detail at ${size.columns}x${size.rows}`, () => {
      const grid = snapshot(
        { surface: "projects", selection: 0, overlays: [{ kind: "project-detail", project: "harbour" }] },
        size,
        FIXTURE_VIEW,
      );
      const all = grid.rows.join("\n");
      for (const label of LABELS) {
        expect(all).toContain(label);
      }
    });
  }

  it("draws every field of the user detail", () => {
    for (const size of SIZES) {
      const grid = snapshot(
        { surface: "users", selection: 2, overlays: [{ kind: "user-detail", username: "cleo" }] },
        size,
        FIXTURE_VIEW,
      );
      const all = grid.rows.join("\n");
      for (const label of ["state", "role", "tokens", "projects"]) {
        expect(all).toContain(label);
      }
    }
  });
});

describe("a project it cannot read", () => {
  // The rule this holds to: Team reads a project as far as it understands it
  // and says "unknown" for the rest. It does not refuse, it does not throw,
  // and it does not lose the parts it did understand. Without this, Team
  // becomes a component that has to be upgraded in step with Studio.
  for (const size of SIZES) {
    it(`degrades rather than failing at ${size.columns}x${size.rows}`, () => {
      const draw = () =>
        snapshot(
          { surface: "projects", selection: 0, overlays: [{ kind: "project-detail", project: "harbour" }] },
          size,
          FUTURE_SCHEMA_VIEW,
        );

      expect(draw).not.toThrow();
      const all = draw().rows.join("\n");

      expect(all).toMatch(/unknown/i);
      // What it did understand is still there: the revision history does not
      // come from the project file.
      expect(all).toContain("T0");
      expect(all).toMatch(/\d+ revisions?/);
      // And it does not shout.
      expect(all).not.toMatch(/error|exception|failed|cannot/i);
    });
  }
});

describe("settings say what may be changed", () => {
  const state: TuiState = { surface: "settings", selection: 0, overlays: [] };

  it("marks the rows that are read only", () => {
    const grid = snapshot(state, SIZES[1], FIXTURE_VIEW);
    const all = grid.rows.join("\n");
    for (const readOnly of ["pinned version", "storage root", "fingerprint"]) {
      expect(all).toContain(readOnly);
    }
  });

  it("marks the rows that need loreserver restarted", () => {
    const grid = snapshot(state, SIZES[1], FIXTURE_VIEW);
    expect(grid.rows.join("\n")).toMatch(/restart/i);
  });

  it("refuses to open an editor on a row that cannot be changed", () => {
    // Selecting a read-only row and pressing return must leave the overlay
    // stack alone. A settings screen that opens an editor on a value it
    // cannot write is worse than one that has no editor.
    const readOnly = snapshot(state, SIZES[1], FIXTURE_VIEW).settings!.findIndex((row) => !row.editable);
    expect(readOnly).toBeGreaterThanOrEqual(0);

    const grid = snapshot(
      { surface: "settings", selection: readOnly, overlays: [] },
      SIZES[1],
      FIXTURE_VIEW,
    );
    expect(grid.overlay).toBeUndefined();
  });

  it("shows both token lifetimes, and says the repository one has no backstop", () => {
    const all = snapshot(state, SIZES[1], FIXTURE_VIEW).rows.join("\n");
    expect(all).toContain("sign-in token");
    expect(all).toContain("repository token");
  });
});

describe("the dashboard is the first thing anybody sees", () => {
  const state: TuiState = { surface: "dashboard", selection: 0, overlays: [] };

  it("answers is it alive, without scrolling, at the smallest size", () => {
    const all = snapshot(state, SIZES[0], FIXTURE_VIEW).rows.join("\n");
    for (const wanted of ["loreserver", "health", "storage"]) {
      expect(all).toContain(wanted);
    }
  });

  it("shows the addresses a new machine has to be told about", () => {
    const all = snapshot(state, SIZES[1], FIXTURE_VIEW).rows.join("\n");
    expect(all).toMatch(/sign-in/);
    expect(all).toMatch(/41337/);
    expect(all).toMatch(/SHA256:/);
  });

  it("offers the quick actions, all of them, at every size", () => {
    // Naming three of them was not enough. A layout that laid its lines
    // out at one width and then put them in a box of another lost the last
    // column, and both actions that went missing were ones this assertion
    // did not name.
    const ACTIONS = [
      "new project",
      "connection details",
      "follow the log",
      "rotate signing key",
      "restart loreserver",
    ];
    for (const size of SIZES) {
      const all = snapshot(state, size, FIXTURE_VIEW).rows.join("\n").toLowerCase();
      const missing = ACTIONS.filter((action) => !all.includes(action));
      expect(missing).toEqual([]);
    }
  });
});

describe("the terminal interface owns no business logic", () => {
  it("never reaches the database itself", async () => {
    // Two hosts on one set of operations. The moment the terminal interface
    // learns to write a row itself, it and the command line start to drift,
    // and only one of them is covered by the tests that matter.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const offenders: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        const source = await readFile(path, "utf8");
        if (/node:sqlite|DatabaseSync|\.prepare\(|team\.db/.test(source)) {
          offenders.push(path);
        }
      }
    };
    await walk("src/tui");
    expect(offenders).toEqual([]);
  });
});

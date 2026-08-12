// What a key does, and what it must not do.
//
// The reducer is a pure function of the state, the key and the view, so every
// one of these is a sequence somebody could type. What is being held to
// account is mostly the second kind of assertion: that a key which would carry
// out something irreversible does not, until it has been confirmed, and that a
// letter typed into a value stays in the value.
import { describe, expect, it } from "vitest";

import {
  INITIAL_STATE,
  reduce,
  topOverlay,
  type Action,
  type KeyPress,
  type Session,
  type TuiState,
} from "../src/tui/state.js";
import { FIXTURE_VIEW } from "./fixtures/hubview.js";

const START: Session = { state: INITIAL_STATE, draft: "" };

function sessionOn(state: Partial<TuiState>, draft = ""): Session {
  return { state: { ...INITIAL_STATE, ...state }, draft };
}

/** Type a run of keys, and answer with where it ended up and what it asked for. */
function type(
  session: Session,
  keys: ReadonlyArray<KeyPress | string>,
): { session: Session; actions: Action[] } {
  const actions: Action[] = [];
  let current = session;
  for (const key of keys) {
    const step = reduce(current, typeof key === "string" ? { input: key } : key, FIXTURE_VIEW);
    current = step.session;
    if (step.action !== undefined) {
      actions.push(step.action);
    }
  }
  return { session: current, actions };
}

describe("moving about", () => {
  it("goes to a surface by its number, and around them with tab", () => {
    expect(type(START, ["3"]).session.state.surface).toBe("projects");
    expect(type(START, [{ input: "", tab: true }]).session.state.surface).toBe("users");
    expect(type(START, [{ input: "", tab: true, shift: true }]).session.state.surface).toBe(
      "settings",
    );
  });

  it("moves the selection with the arrows and with j and k", () => {
    const { session } = type(sessionOn({ surface: "users" }), ["j", "j"]);
    expect(session.state.selection).toBe(2);
    expect(type(session, ["k"]).session.state.selection).toBe(1);
    expect(type(session, [{ input: "", upArrow: true }]).session.state.selection).toBe(1);
  });

  it("stops at both ends rather than selecting a row that is not there", () => {
    const top = type(sessionOn({ surface: "users" }), ["k", "k"]);
    expect(top.session.state.selection).toBe(0);

    const bottom = type(sessionOn({ surface: "users" }), ["j", "j", "j", "j", "j", "j"]);
    expect(bottom.session.state.selection).toBe(FIXTURE_VIEW.users.length - 1);
  });

  it("leaves a window behind when the surface changes", () => {
    // A window about a project, left open over the users list, would be
    // answering a question nobody is looking at any more.
    const { session } = type(sessionOn({ surface: "projects" }), ["l", "2"]);
    expect(session.state.overlays).toEqual([]);
  });
});

describe("the windows", () => {
  it("opens the log from anywhere, and closes it with escape", () => {
    const opened = type(START, ["l"]);
    expect(topOverlay(opened.session.state)?.kind).toBe("log");

    const closed = type(opened.session, [{ input: "", escape: true }]);
    expect(closed.session.state.overlays).toEqual([]);
  });

  it("stacks them, and takes one off at a time", () => {
    const { session } = type(START, ["l", "?"]);
    expect(session.state.overlays.map((overlay) => overlay.kind)).toEqual(["log", "help"]);

    const once = type(session, [{ input: "", escape: true }]);
    expect(once.session.state.overlays.map((overlay) => overlay.kind)).toEqual(["log"]);
  });

  it("opens the detail of whatever is selected", () => {
    const { session } = type(sessionOn({ surface: "projects" }), ["j", { input: "", return: true }]);
    expect(topOverlay(session.state)).toEqual({ kind: "project-detail", project: "lighthouse" });
  });
});

describe("what a key is allowed to carry out", () => {
  it("asks nothing of the host for a key that only moves", () => {
    expect(type(sessionOn({ surface: "users" }), ["j", "k", "l"]).actions).toEqual([]);
  });

  it("takes a confirmation before revoking anybody's tokens", () => {
    const opened = type(sessionOn({ surface: "users", selection: 2 }), ["x"]);
    expect(opened.actions).toEqual([]);
    expect(topOverlay(opened.session.state)).toEqual({ kind: "revoke-tokens", username: "cleo" });

    const agreed = type(opened.session, [{ input: "", return: true }]);
    expect(agreed.actions).toEqual([{ kind: "revoke-tokens", username: "cleo" }]);
    expect(agreed.session.state.overlays).toEqual([]);
  });

  it("acts on the account the confirmation named, not on whatever is selected now", () => {
    const opened = type(sessionOn({ surface: "users", selection: 2 }), ["x"]);
    const agreed = type(opened.session, ["j", { input: "", return: true }]);
    expect(agreed.actions).toEqual([{ kind: "revoke-tokens", username: "cleo" }]);
  });

  it("carries out nothing when a confirmation is left", () => {
    const opened = type(sessionOn({ surface: "users", selection: 2 }), ["x"]);
    const left = type(opened.session, [{ input: "", escape: true }]);
    expect(left.actions).toEqual([]);
    expect(left.session.state.overlays).toEqual([]);
  });

  it("disables an active account and enables a disabled one", () => {
    expect(type(sessionOn({ surface: "users", selection: 0 }), ["d"]).actions).toEqual([
      { kind: "set-user-disabled", username: "ada", disabled: true },
    ]);
    expect(type(sessionOn({ surface: "users", selection: 2 }), ["d"]).actions).toEqual([
      { kind: "set-user-disabled", username: "cleo", disabled: false },
    ]);
  });

  it("reads k as the quick action only where there is no selection to move", () => {
    expect(type(START, ["k"]).actions).toEqual([{ kind: "rotate-key" }]);
    expect(type(sessionOn({ surface: "users", selection: 1 }), ["k"]).actions).toEqual([]);
  });
});

describe("changing a setting", () => {
  const settings = sessionOn({ surface: "settings" });

  it("opens the editor on the value as it stands", () => {
    const { session } = type(settings, ["j", { input: "", return: true }]);
    expect(topOverlay(session.state)).toEqual({ kind: "edit-setting", index: 1 });
    expect(session.draft).toBe(FIXTURE_VIEW.settings[1]?.value);
  });

  it("opens nothing on a row that cannot be written", () => {
    // An editor over a value that would be thrown away is worse than no
    // editor, because it looks like it worked.
    const readOnly = FIXTURE_VIEW.settings.findIndex((setting) => !setting.editable);
    const { session, actions } = type(sessionOn({ surface: "settings", selection: readOnly }), [
      { input: "", return: true },
    ]);
    expect(session.state.overlays).toEqual([]);
    expect(actions).toEqual([]);
  });

  it("keeps every letter typed into a value, including the ones that are commands", () => {
    // A `q` typed into a duration must not quit, and a `l` must not open the
    // log over the thing being typed.
    const opened = type(settings, [{ input: "", return: true }]);
    const typed = type({ state: opened.session.state, draft: "" }, ["9", "0", "q", "l", "d"]);
    expect(typed.session.draft).toBe("90qld");
    expect(typed.actions).toEqual([]);
  });

  it("rubs out the last character, and saves what is left", () => {
    const opened = type(settings, [{ input: "", return: true }]);
    const typed = type({ state: opened.session.state, draft: "" }, [
      "9",
      "0",
      "d",
      { input: "", backspace: true },
    ]);
    expect(typed.session.draft).toBe("90");

    const saved = type(typed.session, [{ input: "", return: true }]);
    expect(saved.actions).toEqual([{ kind: "set-setting", index: 0, value: "90" }]);
    expect(saved.session.state.overlays).toEqual([]);
  });

  it("writes nothing when the editor is left", () => {
    const opened = type(settings, [{ input: "", return: true }]);
    const left = type(opened.session, ["7", { input: "", escape: true }]);
    expect(left.actions).toEqual([]);
    expect(left.session.state.overlays).toEqual([]);
  });
});

describe("leaving", () => {
  it("asks to quit on q, and only outside a window that is taking input", () => {
    expect(type(START, ["q"]).actions).toEqual([{ kind: "quit" }]);

    const confirming = type(sessionOn({ surface: "users", selection: 2 }), ["x"]);
    expect(type(confirming.session, ["q"]).actions).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import {
  breakRun,
  canRedo,
  canUndo,
  classify,
  emptyHistory,
  record,
  redo,
  undo,
  type History,
  type Snapshot,
} from "./history";

function snap(text: string, caret = text.length): Snapshot {
  return { text, selStart: caret, selEnd: caret };
}

/** Apply a run of edits, returning the history and the final text. */
function type(words: string[], gapMs: number): { history: History; text: string } {
  let history = emptyHistory();
  let text = "";
  let now = 1000;

  for (const word of words) {
    const previous = text;
    text += word;
    history = record(history, snap(previous), classify(previous, text), {
      forceBreak: false,
      now,
    });
    now += gapMs;
  }
  return { history, text };
}

describe("classify", () => {
  it("distinguishes insertion, deletion and replacement", () => {
    expect(classify("ab", "abc")).toBe("insert");
    expect(classify("abc", "ab")).toBe("delete");
    expect(classify("abc", "abd")).toBe("other");
  });
});

describe("coalescing", () => {
  it("merges a fast run of typing into one undo step", () => {
    const { history } = type(["a", "b", "c"], 50);
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.text).toBe("");
  });

  it("starts a new step after a pause", () => {
    const { history } = type(["a", "b", "c"], 900);
    expect(history.past).toHaveLength(3);
  });

  it("starts a new step when the edit flips from typing to deleting", () => {
    let history = emptyHistory();
    history = record(history, snap(""), "insert", { forceBreak: false, now: 1000 });
    history = record(history, snap("ab"), "delete", { forceBreak: false, now: 1010 });
    expect(history.past).toHaveLength(2);
  });

  it("always starts a new step for a programmatic edit", () => {
    let history = emptyHistory();
    history = record(history, snap(""), "insert", { forceBreak: false, now: 1000 });
    history = record(history, snap("ab"), "other", { forceBreak: false, now: 1005 });
    expect(history.past).toHaveLength(2);
  });

  it("honours an explicit break, which is how newlines split steps", () => {
    let history = emptyHistory();
    history = record(history, snap(""), "insert", { forceBreak: false, now: 1000 });
    history = record(history, snap("a"), "insert", { forceBreak: true, now: 1005 });
    expect(history.past).toHaveLength(2);
  });
});

describe("undo and redo", () => {
  it("rewinds to the state before the run", () => {
    const { history, text } = type(["hello"], 50);
    const result = undo(history, snap(text));
    expect(result?.snapshot.text).toBe("");
  });

  it("round-trips", () => {
    const { history, text } = type(["one", "two"], 900);
    const first = undo(history, snap(text));
    expect(first?.snapshot.text).toBe("one");

    const back = redo(first!.history, snap(first!.snapshot.text));
    expect(back?.snapshot.text).toBe("onetwo");
  });

  it("restores the caret along with the text", () => {
    let history = emptyHistory();
    history = record(history, { text: "abc", selStart: 3, selEnd: 3 }, "insert", {
      forceBreak: false,
      now: 1000,
    });
    expect(undo(history, snap("abcd"))?.snapshot.selStart).toBe(3);
  });

  it("returns null rather than throwing at the ends of the stack", () => {
    expect(undo(emptyHistory(), snap("x"))).toBeNull();
    expect(redo(emptyHistory(), snap("x"))).toBeNull();
  });

  it("discards the redo branch once a new edit lands", () => {
    const { history, text } = type(["one", "two"], 900);
    const undone = undo(history, snap(text))!;
    expect(canRedo(undone.history)).toBe(true);

    const edited = record(undone.history, snap("one"), "insert", { forceBreak: false, now: 5000 });
    expect(canRedo(edited)).toBe(false);
    expect(canUndo(edited)).toBe(true);
  });

  it("does not merge a keystroke straight after an undo into the restored step", () => {
    const { history, text } = type(["abc"], 50);
    const undone = undo(history, snap(text))!;
    const next = record(undone.history, snap(""), "insert", { forceBreak: false, now: 1100 });
    expect(next.past).toHaveLength(1);
  });
});

describe("breakRun", () => {
  it("makes the next edit start a fresh step, as on a tab switch", () => {
    let history = record(emptyHistory(), snap(""), "insert", { forceBreak: false, now: 1000 });
    history = breakRun(history);
    history = record(history, snap("a"), "insert", { forceBreak: false, now: 1010 });
    expect(history.past).toHaveLength(2);
  });
});

describe("bounds", () => {
  it("caps retained states and drops the oldest first", () => {
    let history = emptyHistory();
    for (let i = 0; i < 400; i += 1) {
      history = record(history, snap(`step-${i}`), "other", { forceBreak: true, now: i * 1000 });
    }
    expect(history.past).toHaveLength(300);
    expect(history.past[0]?.text).toBe("step-100");
  });
});

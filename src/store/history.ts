/**
 * Per-tab undo/redo.
 *
 * The browser's native textarea undo stack cannot be used here. It is owned by the DOM
 * node, so it dies the moment the textarea unmounts — and the editor mounts exactly one
 * textarea and swaps its value between tabs, which would let an undo in tab B rewind text
 * from tab A. It is also unaware of programmatic edits, so the Ctrl+Enter move would be
 * invisible to it.
 *
 * So the stack lives here, keyed by tab, entirely in normal state. Pure functions, no
 * React, unit-tested.
 */

export interface Snapshot {
  text: string;
  selStart: number;
  selEnd: number;
}

export interface History {
  /** States to rewind to. The last entry is the most recent. */
  past: Snapshot[];
  /** States to fast-forward to, newest first. Cleared by any fresh edit. */
  future: Snapshot[];
  /** Timestamp of the last recorded edit, for coalescing. */
  lastEditAt: number;
  lastKind: EditKind;
}

/** How a change altered the document. Runs of the same kind merge into one undo step. */
export type EditKind = "insert" | "delete" | "other";

/**
 * A run of typing longer than this starts a new undo step, so holding a key for a minute
 * does not become one un-undoable blob.
 */
const COALESCE_MS = 500;

/**
 * Cap on retained states. Each holds a full copy of the text, so a 5000-line note at 300
 * entries is roughly 60 MB worst case — acceptable, and reached only after 300 distinct
 * pauses in typing. Older entries are dropped from the front.
 */
const MAX_ENTRIES = 300;

export function emptyHistory(): History {
  return { past: [], future: [], lastEditAt: 0, lastKind: "other" };
}

export function classify(before: string, after: string): EditKind {
  if (after.length > before.length) return "insert";
  if (after.length < before.length) return "delete";
  return "other";
}

/**
 * Record that the document moved from `previous` to some new state.
 *
 * Only `previous` is stored — the new state is the live one, held by the editor. An entry
 * is *not* pushed when the edit continues an existing run: same kind, within
 * [`COALESCE_MS`], and not a newline. That is what makes a sentence undo as a sentence
 * rather than a character at a time.
 *
 * Any recorded edit clears the redo stack, which is the standard branch-discarding
 * behaviour users expect.
 */
export function record(
  history: History,
  previous: Snapshot,
  kind: EditKind,
  options: { forceBreak: boolean; now: number },
): History {
  const { forceBreak, now } = options;

  const continuesRun =
    !forceBreak &&
    kind !== "other" &&
    kind === history.lastKind &&
    now - history.lastEditAt < COALESCE_MS &&
    history.past.length > 0;

  if (continuesRun) {
    // Keep the existing entry: it is the state from before this run of typing started.
    return { ...history, future: [], lastEditAt: now, lastKind: kind };
  }

  const past = [...history.past, previous];
  if (past.length > MAX_ENTRIES) past.shift();

  return { past, future: [], lastEditAt: now, lastKind: kind };
}

/**
 * Rewind one step. `current` is pushed onto the redo stack so the move is reversible.
 * Returns `null` when there is nothing to undo, letting the caller no-op cleanly.
 */
export function undo(history: History, current: Snapshot): { history: History; snapshot: Snapshot } | null {
  const snapshot = history.past[history.past.length - 1];
  if (!snapshot) return null;

  return {
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future],
      // Reset the run so a keystroke straight after an undo starts its own entry.
      lastEditAt: 0,
      lastKind: "other",
    },
    snapshot,
  };
}

export function redo(history: History, current: Snapshot): { history: History; snapshot: Snapshot } | null {
  const snapshot = history.future[0];
  if (!snapshot) return null;

  return {
    history: {
      past: [...history.past, current],
      future: history.future.slice(1),
      lastEditAt: 0,
      lastKind: "other",
    },
    snapshot,
  };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

/**
 * Force the next edit to start a fresh undo step.
 *
 * Called on tab switch and on blur: returning to a tab five minutes later and typing
 * should not merge into whatever you were typing when you left.
 */
export function breakRun(history: History): History {
  return { ...history, lastEditAt: 0, lastKind: "other" };
}

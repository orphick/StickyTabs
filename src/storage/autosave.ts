/**
 * Autosave.
 *
 * The contract this module upholds:
 *
 * - **Debounce.** A note is written 400ms after the last keystroke, not on every one.
 *   Typing a 5000-line note is thousands of keystrokes; writing each of them would mean
 *   thousands of fsyncs.
 * - **Forced flush.** `flushAll()` writes everything pending *right now* and resolves only
 *   when the disk is caught up. It is awaited on tab switch, window blur, window close and
 *   tray-quit — the four moments where a lost keystroke would be visible to the user.
 * - **No lost writes under overlap.** Writes for the same key are chained, never run
 *   concurrently. Two overlapping `save_note` calls for one slug could otherwise land in
 *   either order, and the older text would win.
 * - **Last value wins.** While a write is in flight, further edits replace the pending
 *   value rather than queueing behind each other. Only the newest text matters.
 *
 * A "key" here is a write target: `note:<slug>`, `tabs`, or `settings`. Each key has its
 * own debounce timer and its own chain.
 */

import { saveNote, saveSettings, saveTabs } from "./api";
import type { Settings, TabEntry } from "./types";

/** Milliseconds of quiet before a pending write goes to disk. Specified at 400ms. */
const DEBOUNCE_MS = 400;

/**
 * Tab order and settings are cheap and change rarely (a click, not a keystroke), so they
 * get a shorter debounce — mostly just enough to collapse a burst of reorder events.
 */
const META_DEBOUNCE_MS = 150;

interface PendingWrite {
  /** Runs the actual IPC call for whatever value is currently pending. */
  run: () => Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Keys with a value waiting to be written. */
const pending = new Map<string, PendingWrite>();

/** Per-key serialisation. A key's writes always execute in the order they were queued. */
const chains = new Map<string, Promise<void>>();

/** Notified after every successful write, to drive the status bar's saved-dot. */
type SavedListener = () => void;
const savedListeners = new Set<SavedListener>();

/** Notified when a write fails, so the UI can say so instead of silently losing text. */
type ErrorListener = (message: string) => void;
const errorListeners = new Set<ErrorListener>();

export function onSaved(listener: SavedListener): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

export function onSaveError(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

/**
 * Append a write to a key's chain and return the chain, so callers can await the point at
 * which *this* write has completed.
 *
 * The `.catch` inside is deliberate: a failed write must not poison the chain, or every
 * subsequent save for that key would reject too and the app would stop saving entirely
 * after one transient error.
 */
function enqueue(key: string, run: () => Promise<void>): Promise<void> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await run();
      for (const listener of savedListeners) listener();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const listener of errorListeners) listener(message);
    }
  });
  chains.set(key, next);
  return next;
}

/**
 * Schedule `run` for `key`, replacing any value already waiting.
 *
 * Restarting the timer on every call is what makes this a *trailing* debounce: the write
 * happens once the user stops, not once per burst.
 */
function schedule(key: string, delay: number, run: () => Promise<void>): void {
  const existing = pending.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const entry: PendingWrite = {
    run,
    timer: setTimeout(() => {
      // Clear before enqueueing, so a flush arriving mid-write does not run it twice.
      pending.delete(key);
      void enqueue(key, run);
    }, delay),
  };
  pending.set(key, entry);
}

/** Queue a note's text. This is the hot path — one call per keystroke. */
export function queueNote(slug: string, text: string): void {
  schedule(`note:${slug}`, DEBOUNCE_MS, () => saveNote(slug, text));
}

export function queueTabs(tabs: TabEntry[], activeSlug: string | null): void {
  schedule("tabs", META_DEBOUNCE_MS, () => saveTabs(tabs, activeSlug));
}

export function queueSettings(settings: Settings): void {
  schedule("settings", META_DEBOUNCE_MS, () => saveSettings(settings));
}

/**
 * Write everything pending immediately and wait for the disk to catch up.
 *
 * Awaiting the chains *after* draining `pending` matters: draining appends the flushed
 * writes to their chains, so the second loop covers both the newly-forced writes and any
 * write that was already in flight when the flush arrived.
 *
 * Never rejects. Callers use it in `beforeunload`-shaped paths where a rejection would
 * strand the app half-closed; failures are reported through `onSaveError` instead.
 */
export async function flushAll(): Promise<void> {
  for (const [key, entry] of pending) {
    if (entry.timer) clearTimeout(entry.timer);
    void enqueue(key, entry.run);
  }
  pending.clear();
  await Promise.all(Array.from(chains.values()));
}

/** True when a write is queued but not yet on disk. Drives the "unsaved" dot state. */
export function hasPendingWrites(): boolean {
  return pending.size > 0;
}

/**
 * Drop a note's queued write. Used when a tab is closed: its text has already been moved
 * to `_trash`, and letting a stale debounce fire would recreate the `.txt` we just
 * removed and resurrect the tab on the next start.
 */
export function cancelNote(slug: string): void {
  const key = `note:${slug}`;
  const entry = pending.get(key);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(key);
}

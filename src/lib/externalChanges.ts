import type { TabEntry } from "../storage/types";

/** One note that changed on disk underneath the app. */
export interface NoteChange {
  slug: string;
  /** Suggested display name, used only when the slug is not open as a tab yet. */
  name: string;
  text: string;
}

export interface ExternalPlan {
  /** Notes to replace in place — same text on disk is newer, and nothing local is at risk. */
  reload: NoteChange[];
  /** Files that appeared in the folder and should become new tabs. */
  adopt: NoteChange[];
  /**
   * Notes changed on disk while the app also has unsaved edits. Never applied
   * automatically: both versions are real work, and picking one silently would throw the
   * other away. The user is asked instead.
   */
  conflicts: NoteChange[];
}

/**
 * Decide what to do about a batch of on-disk changes.
 *
 * Split out as a pure function so the rules are testable without a filesystem, a webview,
 * or a running app — the interesting cases (unsaved edits, no-op events, unknown slugs)
 * are exactly the ones that are painful to stage by hand.
 */
export function planExternalChanges(options: {
  changes: NoteChange[];
  tabs: TabEntry[];
  notes: Record<string, string>;
  /** True when this slug still has edits waiting to be written. */
  isDirty: (slug: string) => boolean;
}): ExternalPlan {
  const { changes, tabs, notes, isDirty } = options;
  const known = new Set(tabs.map((tab) => tab.slug));

  const plan: ExternalPlan = { reload: [], adopt: [], conflicts: [] };

  for (const change of changes) {
    if (!known.has(change.slug)) {
      plan.adopt.push(change);
      continue;
    }
    // Already identical — a save echo that slipped through, or a no-op write by another
    // program. Reloading would be a pointless caret jump.
    if ((notes[change.slug] ?? "") === change.text) continue;

    if (isDirty(change.slug)) plan.conflicts.push(change);
    else plan.reload.push(change);
  }

  return plan;
}

/** Wording for the toast shown after notes were reloaded from disk. */
export function reloadMessage(names: string[]): string {
  if (names.length === 1) return `${names[0]} reloaded from disk`;
  return `${names.length} notes reloaded from disk`;
}

/** Wording for the toast shown when disk and unsaved edits disagree. */
export function conflictMessage(names: string[]): string {
  if (names.length === 1) return `${names[0]} also changed on disk`;
  return `${names.length} notes also changed on disk`;
}

/**
 * The only place the frontend talks to Rust.
 *
 * Every function here is a thin, typed wrapper over one `#[tauri::command]`. Keeping them
 * in one file means the IPC surface can be read in thirty seconds, and it makes the
 * autosave layer's job unambiguous: it calls `saveNote`, nothing else.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Settings, TabEntry, Workspace } from "./types";

/** Today's date as `YYYY-MM-DD` in the user's *local* timezone.
 *
 * Not `toISOString()` — that converts to UTC first, so anyone west of Greenwich would get
 * yesterday's heading for most of their evening. The Report heading has to match the day
 * the user thinks it is.
 */
export function localDateISO(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** One round trip: tabs, all note text, and settings. */
export function loadWorkspace(): Promise<Workspace> {
  return invoke<Workspace>("load_workspace", { today: localDateISO() });
}

/** Atomically replace one note's `.txt`. */
export function saveNote(slug: string, text: string): Promise<void> {
  return invoke<void>("save_note", { slug, text });
}

/** Persist tab order, names, and which tab is active. */
export function saveTabs(tabs: TabEntry[], activeSlug: string | null): Promise<void> {
  return invoke<void>("save_tabs", { tabs, activeSlug });
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

/** Create an empty `.txt` and return the slug it actually got (may be suffixed). */
export function createNote(name: string): Promise<string> {
  return invoke<string>("create_note", { name });
}

/** Move `<slug>.txt` to a slug derived from `newName`; returns the new slug. */
export function renameNote(slug: string, newName: string): Promise<string> {
  return invoke<string>("rename_note", { slug, newName });
}

/** Move `<slug>.txt` into `notes\_trash\`. Nothing is ever deleted. */
export function trashNote(slug: string): Promise<void> {
  return invoke<void>("trash_note", { slug });
}

export function openNotesFolder(): Promise<void> {
  return invoke<void>("open_notes_folder");
}

export function setAlwaysOnTop(value: boolean): Promise<void> {
  return invoke<void>("set_always_on_top", { value });
}

/** Reveal the window once the first paint is ready. */
export function showMainWindow(): Promise<void> {
  return invoke<void>("show_main_window");
}

/** Persist window position and size. Called before hiding to the tray, so the geometry
 * survives even if the process is later killed rather than quit cleanly. */
export function saveWindowGeometry(): Promise<void> {
  return invoke<void>("save_window_geometry");
}

/** Terminate the process. Only called after every pending write has settled. */
export function quitApp(): Promise<void> {
  return invoke<void>("quit_app");
}

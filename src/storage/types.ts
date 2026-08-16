/**
 * Mirrors of the serde structs in `src-tauri/src/storage.rs`.
 *
 * These two definitions must be changed together. Rust serialises with
 * `#[serde(rename_all = "camelCase")]`, so every field here is the camelCase form of the
 * snake_case field over there.
 */

export type Theme = "dark" | "light";

/** Only 13, 14 and 15 exist. The mockup settled on three steps and no more. */
export const FONT_SIZES = [13, 14, 15] as const;
export type FontSize = (typeof FONT_SIZES)[number];

export interface TabEntry {
  /** Filename stem under `notes\`. Changes only on rename. */
  slug: string;
  /** Free-form display name. */
  name: string;
}

/** Caret offset and scroll position for one tab. Persisted, so it survives a restart. */
export interface TabUiState {
  caret: number;
  scrollTop: number;
}

export interface Settings {
  version: number;
  theme: Theme;
  fontSize: FontSize;
  wrap: boolean;
  alwaysOnTop: boolean;
  /** `null` means "use the tab literally named Report", resolved at runtime. */
  reportSlug: string | null;
  perTab: Record<string, TabUiState>;
}

/** Everything needed to render, delivered by a single `load_workspace` call. */
export interface Workspace {
  tabs: TabEntry[];
  activeSlug: string | null;
  notes: Record<string, string>;
  settings: Settings;
  notesDir: string;
  firstRun: boolean;
  recovered: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: "dark",
  fontSize: 14,
  wrap: true,
  alwaysOnTop: true,
  reportSlug: null,
  perTab: {},
};

/**
 * Coerce a settings object that came off disk into a valid one.
 *
 * Rust already rejects a wholly unparseable file, but a hand-edited `settings.json` can
 * be valid JSON with a nonsense `theme` or `fontSize`. Clamping here means one bad value
 * degrades to its default instead of rendering an unreadable window.
 */
export function normalizeSettings(raw: Settings): Settings {
  const fontSize = (FONT_SIZES as readonly number[]).includes(raw.fontSize)
    ? raw.fontSize
    : DEFAULT_SETTINGS.fontSize;

  return {
    version: DEFAULT_SETTINGS.version,
    theme: raw.theme === "light" ? "light" : "dark",
    fontSize,
    wrap: typeof raw.wrap === "boolean" ? raw.wrap : DEFAULT_SETTINGS.wrap,
    alwaysOnTop:
      typeof raw.alwaysOnTop === "boolean" ? raw.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    reportSlug: typeof raw.reportSlug === "string" ? raw.reportSlug : null,
    perTab: raw.perTab ?? {},
  };
}

import { create } from "zustand";

import * as api from "../storage/api";
import { cancelNote, flushAll, queueNote, queueSettings, queueTabs } from "../storage/autosave";
import type { FontSize, Settings, TabEntry, TabUiState, Theme } from "../storage/types";
import { DEFAULT_SETTINGS, FONT_SIZES, normalizeSettings } from "../storage/types";
import {
  breakRun,
  classify,
  emptyHistory,
  record,
  redo as redoHistory,
  undo as undoHistory,
  type History,
  type Snapshot,
} from "./history";
import { cutRange, insertIntoReport, lineRangeAt, linesIn, resolveReportSlug } from "../lib/report";
import { readScrollTop, readSelection, restoreSelection } from "./editorRef";

/** What an active toast is offering to undo. Both documents are snapshotted whole, which
 * makes the undo exact regardless of how the report insertion reshaped the file. */
interface MoveUndo {
  sourceSlug: string;
  sourceText: string;
  sourceCaret: number;
  reportSlug: string;
  reportText: string;
}

export interface Toast {
  message: string;
  undo: MoveUndo | null;
}

interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  /** Index into the current match list; -1 when nothing is selected. */
  index: number;
}

interface State {
  ready: boolean;
  loadError: string | null;
  notesDir: string;

  tabs: TabEntry[];
  notes: Record<string, string>;
  activeSlug: string | null;
  settings: Settings;
  histories: Record<string, History>;

  find: FindState;
  toast: Toast | null;
  settingsOpen: boolean;

  init: () => Promise<void>;

  setText: (slug: string, text: string, selStart: number, selEnd: number) => void;
  setActive: (slug: string) => Promise<void>;
  cycle: (delta: number) => Promise<void>;
  jumpTo: (index: number) => Promise<void>;

  addTab: () => Promise<void>;
  renameTab: (slug: string, name: string) => Promise<void>;
  closeTab: (slug: string) => Promise<void>;
  reorderTabs: (from: number, to: number) => void;

  undo: () => void;
  redo: () => void;

  rememberTabUi: (slug: string, ui: TabUiState) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
  stepFontSize: (delta: number) => void;
  toggleWrap: () => void;
  toggleAlwaysOnTop: () => Promise<void>;
  setSettingsOpen: (open: boolean) => void;

  setFind: (patch: Partial<FindState>) => void;
  showToast: (message: string, undo?: MoveUndo | null) => void;
  dismissToast: () => void;

  moveLineToReport: () => void;
  undoMove: () => void;

  reportSlug: () => string | null;
  activeText: () => string;
}

/** Snapshot of the live document, used to seed an undo entry. */
function snapshotOf(state: State, slug: string): Snapshot {
  const { selStart, selEnd } = readSelection();
  return { text: state.notes[slug] ?? "", selStart, selEnd };
}

function historyFor(state: State, slug: string): History {
  return state.histories[slug] ?? emptyHistory();
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  loadError: null,
  notesDir: "",

  tabs: [],
  notes: {},
  activeSlug: null,
  settings: DEFAULT_SETTINGS,
  histories: {},

  find: { open: false, query: "", caseSensitive: false, index: -1 },
  toast: null,
  settingsOpen: false,

  async init() {
    try {
      const ws = await api.loadWorkspace();
      const settings = normalizeSettings(ws.settings);

      set({
        ready: true,
        notesDir: ws.notesDir,
        tabs: ws.tabs,
        notes: ws.notes,
        activeSlug: ws.activeSlug,
        settings,
        histories: {},
      });

      // The window is created hidden so the user never sees an unstyled frame; reveal it
      // only once there is something real to look at.
      await api.showMainWindow();

      const active = ws.activeSlug;
      if (active) {
        const ui = settings.perTab[active];
        restoreSelection(ui?.caret ?? 0, ui?.caret ?? 0, ui?.scrollTop ?? 0);
      }
    } catch (error) {
      set({
        ready: true,
        loadError: error instanceof Error ? error.message : String(error),
      });
      await api.showMainWindow();
    }
  },

  setText(slug, text, selStart, selEnd) {
    const state = get();
    const previousText = state.notes[slug] ?? "";
    if (previousText === text) return;

    const kind = classify(previousText, text);
    // A newline always breaks the run, so undo steps line up with lines — the unit a
    // plain-text note is actually made of.
    const forceBreak = text.length > previousText.length && text.slice(0, selStart).endsWith("\n");

    const history = record(
      historyFor(state, slug),
      { text: previousText, selStart, selEnd },
      kind,
      { forceBreak, now: Date.now() },
    );

    set({
      notes: { ...state.notes, [slug]: text },
      histories: { ...state.histories, [slug]: history },
    });

    queueNote(slug, text);
  },

  async setActive(slug) {
    const state = get();
    if (state.activeSlug === slug) return;

    // Forced save on tab switch, plus remember where the caret was in the tab we leave.
    if (state.activeSlug) {
      const { selStart } = readSelection();
      get().rememberTabUi(state.activeSlug, { caret: selStart, scrollTop: readScrollTop() });
      set((s) => ({
        histories: { ...s.histories, [state.activeSlug as string]: breakRun(historyFor(s, state.activeSlug as string)) },
      }));
    }
    await flushAll();

    set({ activeSlug: slug, find: { ...get().find, index: -1 } });
    queueTabs(get().tabs, slug);

    const ui = get().settings.perTab[slug];
    restoreSelection(ui?.caret ?? 0, ui?.caret ?? 0, ui?.scrollTop ?? 0);
  },

  async cycle(delta) {
    const { tabs, activeSlug } = get();
    if (tabs.length === 0) return;
    const current = tabs.findIndex((t) => t.slug === activeSlug);
    const next = tabs[(current + delta + tabs.length) % tabs.length];
    if (next) await get().setActive(next.slug);
  },

  async jumpTo(index) {
    const tab = get().tabs[index];
    if (tab) await get().setActive(tab.slug);
  },

  async addTab() {
    await flushAll();
    // Number the display name too, not just the slug. Two tabs both reading "Untitled" are
    // indistinguishable on the strip even though their files differ.
    const used = new Set(get().tabs.map((t) => t.name));
    let name = "Untitled";
    for (let n = 2; used.has(name); n += 1) name = `Untitled ${n}`;

    const slug = await api.createNote(name);
    const tabs = [...get().tabs, { slug, name }];
    set({ tabs, notes: { ...get().notes, [slug]: "" } });
    queueTabs(tabs, slug);
    await get().setActive(slug);
  },

  async renameTab(slug, name) {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;

    // Rename the file too, so the notes folder stays readable from Explorer. The write of
    // the current text must land first, or the rename would move a stale file.
    await flushAll();
    const newSlug = await api.renameNote(slug, trimmed);

    set((s) => {
      const tabs = s.tabs.map((t) => (t.slug === slug ? { slug: newSlug, name: trimmed } : t));
      const notes = { ...s.notes };
      const histories = { ...s.histories };
      const perTab = { ...s.settings.perTab };

      if (newSlug !== slug) {
        notes[newSlug] = notes[slug] ?? "";
        delete notes[slug];
        const history = histories[slug];
        if (history) histories[newSlug] = history;
        delete histories[slug];
        const ui = perTab[slug];
        if (ui) perTab[newSlug] = ui;
        delete perTab[slug];
      }

      const settings: Settings = {
        ...s.settings,
        perTab,
        reportSlug: s.settings.reportSlug === slug ? newSlug : s.settings.reportSlug,
      };
      const activeSlug = s.activeSlug === slug ? newSlug : s.activeSlug;

      queueTabs(tabs, activeSlug);
      queueSettings(settings);
      return { tabs, notes, histories, settings, activeSlug };
    });
  },

  async closeTab(slug) {
    // Drop the debounced write first. Letting it fire after the file has been moved to
    // _trash would recreate the .txt and the tab would come back on the next start.
    cancelNote(slug);
    await api.trashNote(slug);

    set((s) => {
      const index = s.tabs.findIndex((t) => t.slug === slug);
      const tabs = s.tabs.filter((t) => t.slug !== slug);
      const notes = { ...s.notes };
      delete notes[slug];
      const histories = { ...s.histories };
      delete histories[slug];
      const perTab = { ...s.settings.perTab };
      delete perTab[slug];

      const activeSlug =
        s.activeSlug === slug
          ? (tabs[Math.min(index, tabs.length - 1)]?.slug ?? null)
          : s.activeSlug;

      const settings: Settings = {
        ...s.settings,
        perTab,
        reportSlug: s.settings.reportSlug === slug ? null : s.settings.reportSlug,
      };

      queueTabs(tabs, activeSlug);
      queueSettings(settings);
      return { tabs, notes, histories, activeSlug, settings };
    });

    const active = get().activeSlug;
    if (active) {
      const ui = get().settings.perTab[active];
      restoreSelection(ui?.caret ?? 0, ui?.caret ?? 0, ui?.scrollTop ?? 0);
    }
  },

  reorderTabs(from, to) {
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) {
        return {};
      }
      const tabs = [...s.tabs];
      const [moved] = tabs.splice(from, 1);
      if (!moved) return {};
      tabs.splice(to, 0, moved);
      queueTabs(tabs, s.activeSlug);
      return { tabs };
    });
  },

  undo() {
    const state = get();
    const slug = state.activeSlug;
    if (!slug) return;

    const result = undoHistory(historyFor(state, slug), snapshotOf(state, slug));
    if (!result) return;

    set({
      notes: { ...state.notes, [slug]: result.snapshot.text },
      histories: { ...state.histories, [slug]: result.history },
    });
    queueNote(slug, result.snapshot.text);
    restoreSelection(result.snapshot.selStart, result.snapshot.selEnd);
  },

  redo() {
    const state = get();
    const slug = state.activeSlug;
    if (!slug) return;

    const result = redoHistory(historyFor(state, slug), snapshotOf(state, slug));
    if (!result) return;

    set({
      notes: { ...state.notes, [slug]: result.snapshot.text },
      histories: { ...state.histories, [slug]: result.history },
    });
    queueNote(slug, result.snapshot.text);
    restoreSelection(result.snapshot.selStart, result.snapshot.selEnd);
  },

  rememberTabUi(slug, ui) {
    set((s) => {
      const previous = s.settings.perTab[slug];
      if (previous && previous.caret === ui.caret && previous.scrollTop === ui.scrollTop) {
        return {};
      }
      const settings: Settings = { ...s.settings, perTab: { ...s.settings.perTab, [slug]: ui } };
      queueSettings(settings);
      return { settings };
    });
  },

  patchSettings(patch) {
    set((s) => {
      const settings: Settings = { ...s.settings, ...patch };
      queueSettings(settings);
      return { settings };
    });
  },

  setTheme(theme) {
    get().patchSettings({ theme });
  },

  setFontSize(fontSize) {
    get().patchSettings({ fontSize });
  },

  stepFontSize(delta) {
    const sizes = FONT_SIZES;
    const current = sizes.indexOf(get().settings.fontSize);
    const next = sizes[Math.max(0, Math.min(sizes.length - 1, current + delta))];
    if (next !== undefined) get().patchSettings({ fontSize: next });
  },

  toggleWrap() {
    get().patchSettings({ wrap: !get().settings.wrap });
  },

  async toggleAlwaysOnTop() {
    const value = !get().settings.alwaysOnTop;
    get().patchSettings({ alwaysOnTop: value });
    await api.setAlwaysOnTop(value);
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  setFind(patch) {
    set((s) => ({ find: { ...s.find, ...patch } }));
  },

  showToast(message, undo = null) {
    set({ toast: { message, undo } });
  },

  dismissToast() {
    set({ toast: null });
  },

  /**
   * Ctrl+Enter: cut the current line (or whole selection) out of this tab and file it in
   * the Report tab under today's date.
   */
  moveLineToReport() {
    const state = get();
    const slug = state.activeSlug;
    if (!slug) return;

    const reportSlug = state.reportSlug();
    if (!reportSlug) {
      state.showToast("No Report tab — pick one in settings");
      return;
    }
    if (reportSlug === slug) {
      state.showToast("Already in the Report tab");
      return;
    }

    const sourceText = state.notes[slug] ?? "";
    const { selStart, selEnd } = readSelection();
    const range = lineRangeAt(sourceText, selStart, selEnd);
    const lines = linesIn(sourceText, range);

    if (lines.every((line) => line.trim() === "")) {
      state.showToast("Nothing to move");
      return;
    }

    const reportText = state.notes[reportSlug] ?? "";
    const cut = cutRange(sourceText, range);
    const nextReport = insertIntoReport(reportText, lines, api.localDateISO());

    set({
      notes: { ...state.notes, [slug]: cut.text, [reportSlug]: nextReport },
      // Both documents changed programmatically, so both undo runs must break.
      histories: {
        ...state.histories,
        [slug]: record(historyFor(state, slug), { text: sourceText, selStart, selEnd }, "other", {
          forceBreak: true,
          now: Date.now(),
        }),
        [reportSlug]: record(
          historyFor(state, reportSlug),
          { text: reportText, selStart: 0, selEnd: 0 },
          "other",
          { forceBreak: true, now: Date.now() },
        ),
      },
      toast: {
        message: lines.length > 1 ? `Moved ${lines.length} lines to Report` : "Moved to Report",
        undo: { sourceSlug: slug, sourceText, sourceCaret: selStart, reportSlug, reportText },
      },
    });

    queueNote(slug, cut.text);
    queueNote(reportSlug, nextReport);
    restoreSelection(cut.caret, cut.caret);
  },

  /** Put both documents back exactly as they were before the move. */
  undoMove() {
    const state = get();
    const move = state.toast?.undo;
    if (!move) return;

    set({
      notes: {
        ...state.notes,
        [move.sourceSlug]: move.sourceText,
        [move.reportSlug]: move.reportText,
      },
      toast: null,
    });

    queueNote(move.sourceSlug, move.sourceText);
    queueNote(move.reportSlug, move.reportText);

    if (state.activeSlug === move.sourceSlug) {
      restoreSelection(move.sourceCaret, move.sourceCaret);
    }
  },

  reportSlug() {
    return resolveReportSlug(get().tabs, get().settings.reportSlug);
  },

  activeText() {
    const { activeSlug, notes } = get();
    return activeSlug ? (notes[activeSlug] ?? "") : "";
  },
}));

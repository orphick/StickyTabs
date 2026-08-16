import { useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Editor } from "./components/Editor";
import { FindBar } from "./components/FindBar";
import { SettingsModal } from "./components/SettingsModal";
import { StatusBar } from "./components/StatusBar";
import { TabStrip } from "./components/TabStrip";
import { TitleBar } from "./components/TitleBar";
import { Toast } from "./components/Toast";
import { findMatches, matchAfter } from "./lib/find";
import { handleKeyDown } from "./lib/keys";
import { quitApp, saveWindowGeometry } from "./storage/api";
import { flushAll } from "./storage/autosave";
import { readScrollTop, readSelection, restoreSelection } from "./store/editorRef";
import { useStore } from "./store/store";

/** Events emitted by the Rust side. Kept in sync with the constants in `lib.rs`. */
const EVENT_QUIT_REQUESTED = "stickytabs://quit-requested";
const EVENT_SHOWN = "stickytabs://shown";

export function App() {
  const ready = useStore((s) => s.ready);
  const loadError = useStore((s) => s.loadError);
  const theme = useStore((s) => s.settings.theme);
  const fontSize = useStore((s) => s.settings.fontSize);
  const find = useStore((s) => s.find);
  const setFind = useStore((s) => s.setFind);
  const text = useStore((s) => (s.activeSlug ? (s.notes[s.activeSlug] ?? "") : ""));

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  // Theme and font size drive CSS custom properties on the root element, so a change
  // repaints without re-rendering a single component.
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--fs", `${fontSize}px`);
  }, [fontSize]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /**
   * The three forced-save paths that are not tab switches.
   *
   * Closing is handled here rather than in Rust so the flush can be awaited before the
   * window goes away — preventing the close, writing, and only then hiding.
   */
  useEffect(() => {
    const win = getCurrentWindow();

    const unlistenClose = win.onCloseRequested(async (event) => {
      // Closing hides to the tray. Quitting is only possible from the tray menu.
      event.preventDefault();
      rememberCurrentCaret();
      await flushAll();
      await saveWindowGeometry();
      await win.hide();
    });

    const unlistenFocus = win.onFocusChanged(async ({ payload: focused }) => {
      if (focused) return;
      rememberCurrentCaret();
      await flushAll();
    });

    const unlistenQuit = listen(EVENT_QUIT_REQUESTED, async () => {
      rememberCurrentCaret();
      await flushAll();
      await quitApp();
    });

    // Shown by the tray or the global hotkey: put the caret back where it was.
    const unlistenShown = listen(EVENT_SHOWN, () => {
      const state = useStore.getState();
      const slug = state.activeSlug;
      if (!slug) return;
      const ui = state.settings.perTab[slug];
      restoreSelection(ui?.caret ?? 0, ui?.caret ?? 0, ui?.scrollTop ?? 0);
    });

    return () => {
      void unlistenClose.then((off) => off());
      void unlistenFocus.then((off) => off());
      void unlistenQuit.then((off) => off());
      void unlistenShown.then((off) => off());
    };
  }, []);

  // Matches are computed once, here, and shared by the highlight layer and the find bar
  // so the note is never scanned twice for the same query.
  const matches = useMemo(
    () => (find.open ? findMatches(text, find.query, find.caseSensitive) : []),
    [find.open, find.query, find.caseSensitive, text],
  );

  // Opening the bar (or retyping the query) selects the first match at or after the caret,
  // rather than jumping to the top of the file.
  useEffect(() => {
    if (!find.open || find.index !== -1 || matches.length === 0) return;
    setFind({ index: matchAfter(matches, readSelection().selStart) });
  }, [find.open, find.index, matches, setFind]);

  if (!ready) return <div className="boot">…</div>;

  if (loadError) {
    return (
      <div className="app">
        <TitleBar />
        <div className="error">
          StickyTabs could not open its notes folder.
          <br />
          <br />
          {loadError}
          <br />
          <br />
          Your .txt files have not been touched.
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <TabStrip />
      <Editor
        matches={matches}
        currentMatch={find.index}
        findOpen={find.open}
        onOpenFind={() => setFind({ open: true, index: -1 })}
      />
      {find.open ? <FindBar matches={matches} /> : null}
      <StatusBar />
      <Toast />
      <SettingsModal />
    </div>
  );
}

function rememberCurrentCaret(): void {
  const state = useStore.getState();
  if (!state.activeSlug) return;
  state.rememberTabUi(state.activeSlug, {
    caret: readSelection().selStart,
    scrollTop: readScrollTop(),
  });
}

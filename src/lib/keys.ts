/**
 * The single keyboard dispatcher.
 *
 * One listener on `window` in the bubble phase, so a component that owns its own input
 * (the tab rename field, the find query) can opt out with `stopPropagation` and type
 * freely.
 *
 * Every shortcut here calls `preventDefault`. Undo and redo in particular *must*, or the
 * webview's native textarea undo stack would run in addition to the app's, and the two
 * would disagree.
 */

import { flushAll } from "../storage/autosave";
import { useStore } from "../store/store";

export function handleKeyDown(event: KeyboardEvent): void {
  const store = useStore.getState();
  const ctrl = event.ctrlKey || event.metaKey;

  if (event.key === "Escape") {
    if (store.settingsOpen) {
      store.setSettingsOpen(false);
      event.preventDefault();
    } else if (store.find.open) {
      store.setFind({ open: false, index: -1 });
      event.preventDefault();
    }
    return;
  }

  if (!ctrl) return;

  switch (event.key) {
    case "t":
    case "T":
      event.preventDefault();
      void store.addTab();
      return;

    case "w":
    case "W": {
      event.preventDefault();
      const slug = store.activeSlug;
      if (!slug || store.tabs.length <= 1) return;
      const text = store.notes[slug] ?? "";
      if (text.trim().length > 0) {
        const tab = store.tabs.find((t) => t.slug === slug);
        const ok = window.confirm(
          `Close "${tab?.name ?? slug}"?\n\nThe note is moved to the _trash folder, not deleted.`,
        );
        if (!ok) return;
      }
      void store.closeTab(slug);
      return;
    }

    case "Tab":
      event.preventDefault();
      void store.cycle(event.shiftKey ? -1 : 1);
      return;

    case "f":
    case "F":
      event.preventDefault();
      store.setFind({ open: true, index: -1 });
      return;

    case "Enter":
      event.preventDefault();
      store.moveLineToReport();
      return;

    case "s":
    case "S":
      // Not required — the app already autosaves — but Ctrl+S is muscle memory, and doing
      // nothing at all reads as "it didn't save".
      event.preventDefault();
      void flushAll();
      return;

    case "z":
    case "Z":
      event.preventDefault();
      if (event.shiftKey) store.redo();
      else store.undo();
      return;

    case "y":
    case "Y":
      event.preventDefault();
      store.redo();
      return;

    // "=" is the unshifted key on the same cap as "+", so both reach here.
    case "=":
    case "+":
      event.preventDefault();
      store.stepFontSize(1);
      return;

    case "-":
    case "_":
      event.preventDefault();
      store.stepFontSize(-1);
      return;

    default:
      break;
  }

  // Ctrl+1..9 jumps to a tab by position. 9 is the ninth tab, not the last — the spec
  // says "by index", and a surprise jump to the end is worse than a no-op.
  if (event.key >= "1" && event.key <= "9") {
    event.preventDefault();
    void store.jumpTo(Number(event.key) - 1);
  }
}

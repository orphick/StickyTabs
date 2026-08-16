import { getCurrentWindow } from "@tauri-apps/api/window";

import { useStore } from "../store/store";

export function TitleBar() {
  const alwaysOnTop = useStore((s) => s.settings.alwaysOnTop);
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop);

  return (
    <div className="titlebar">
      {/* The whole label area is the drag handle. Tauri's hit-testing needs the attribute
          on the element actually under the pointer, so it goes here rather than on the
          titlebar row, which also contains buttons. */}
      <div className="titlebar__name" data-tauri-drag-region>
        StickyTabs
      </div>

      <button
        type="button"
        className="titlebar__btn"
        title={alwaysOnTop ? "Always on top: on" : "Always on top: off"}
        aria-label="Toggle always on top"
        aria-pressed={alwaysOnTop}
        onClick={() => void toggleAlwaysOnTop()}
      >
        <span className={alwaysOnTop ? "pin pin--on" : "pin"} />
      </button>

      <button
        type="button"
        className="titlebar__btn"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void getCurrentWindow().minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      {/* Closing hides to the tray; the app is only quit from the tray menu. The real
          close is handled by the onCloseRequested listener in App, so this just asks the
          window to close and takes the same path as Alt+F4. */}
      <button
        type="button"
        className="titlebar__btn titlebar__btn--close"
        title="Hide to tray"
        aria-label="Hide to tray"
        onClick={() => void getCurrentWindow().close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

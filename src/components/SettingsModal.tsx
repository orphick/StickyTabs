import { useEffect } from "react";

import { openNotesFolder } from "../storage/api";
import { FONT_SIZES } from "../storage/types";
import type { FontSize } from "../storage/types";
import { useStore } from "../store/store";

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const tabs = useStore((s) => s.tabs);
  const notesDir = useStore((s) => s.notesDir);
  const setTheme = useStore((s) => s.setTheme);
  const setFontSize = useStore((s) => s.setFontSize);
  const toggleWrap = useStore((s) => s.toggleWrap);
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop);
  const patchSettings = useStore((s) => s.patchSettings);
  const reportSlug = useStore((s) => s.reportSlug());

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="modal__scrim" onPointerDown={() => setOpen(false)}>
      <div
        className="modal"
        role="dialog"
        aria-label="Settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="modal__title">Settings</div>

        <div className="row">
          <span className="row__label">Theme</span>
          <div className="seg">
            <button
              type="button"
              className={settings.theme === "dark" ? "seg__btn seg__btn--on" : "seg__btn"}
              onClick={() => setTheme("dark")}
            >
              dark
            </button>
            <button
              type="button"
              className={settings.theme === "light" ? "seg__btn seg__btn--on" : "seg__btn"}
              onClick={() => setTheme("light")}
            >
              light
            </button>
          </div>
        </div>

        <div className="row">
          <span className="row__label">Font size</span>
          <div className="seg">
            {FONT_SIZES.map((size: FontSize) => (
              <button
                key={size}
                type="button"
                className={settings.fontSize === size ? "seg__btn seg__btn--on" : "seg__btn"}
                onClick={() => setFontSize(size)}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <span className="row__label">Long lines</span>
          <div className="seg">
            <button
              type="button"
              className={settings.wrap ? "seg__btn seg__btn--on" : "seg__btn"}
              onClick={() => {
                if (!settings.wrap) toggleWrap();
              }}
            >
              wrap
            </button>
            <button
              type="button"
              className={!settings.wrap ? "seg__btn seg__btn--on" : "seg__btn"}
              onClick={() => {
                if (settings.wrap) toggleWrap();
              }}
            >
              truncate
            </button>
          </div>
        </div>

        <div className="row">
          <span className="row__label">Always on top</span>
          <div className="seg">
            <button
              type="button"
              className={settings.alwaysOnTop ? "seg__btn seg__btn--on" : "seg__btn"}
              onClick={() => {
                if (!settings.alwaysOnTop) void toggleAlwaysOnTop();
              }}
            >
              on
            </button>
            <button
              type="button"
              className={!settings.alwaysOnTop ? "seg__btn seg__btn--on" : "seg__btn"}
              onClick={() => {
                if (settings.alwaysOnTop) void toggleAlwaysOnTop();
              }}
            >
              off
            </button>
          </div>
        </div>

        <div className="row">
          <span className="row__label">Report tab</span>
          <select
            className="select"
            value={reportSlug ?? ""}
            onChange={(event) =>
              patchSettings({ reportSlug: event.target.value === "" ? null : event.target.value })
            }
          >
            <option value="">(none)</option>
            {tabs.map((tab) => (
              <option key={tab.slug} value={tab.slug}>
                {tab.name}
              </option>
            ))}
          </select>
        </div>

        <button type="button" className="modal__wide" onClick={() => void openNotesFolder()}>
          Open notes folder
        </button>
        <div className="modal__path">{notesDir}</div>

        <div className="modal__hint">
          <kbd>Ctrl+Enter</kbd> move line to Report · <kbd>Ctrl+T</kbd> new tab ·{" "}
          <kbd>Ctrl+F</kbd> find · <kbd>Ctrl+Tab</kbd> cycle · <kbd>Ctrl+1..9</kbd> jump ·{" "}
          double-click a tab to rename
        </div>
      </div>
    </div>
  );
}

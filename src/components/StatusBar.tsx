import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { onSaveError, onSaved } from "../storage/autosave";
import { useStore } from "../store/store";

/** How long the saved-dot stays bright after a write. */
const PULSE_MS = 550;

export function StatusBar() {
  const text = useStore((s) => (s.activeSlug ? (s.notes[s.activeSlug] ?? "") : ""));
  const wrap = useStore((s) => s.settings.wrap);
  const toggleWrap = useStore((s) => s.toggleWrap);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  const [pulse, setPulse] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer = 0;
    const offSaved = onSaved(() => {
      setError(null);
      setPulse(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPulse(false), PULSE_MS);
    });
    const offError = onSaveError((message) => setError(message));
    return () => {
      window.clearTimeout(timer);
      offSaved();
      offError();
    };
  }, []);

  // Counting lines in a 5000-line note is cheap but not free, and it is pure decoration.
  // Deferring it keeps the count off the critical path of a keystroke.
  const deferred = useDeferredValue(text);
  const counts = useMemo(() => {
    const lines = deferred.length === 0 ? 0 : deferred.split("\n").length;
    const items = deferred.split("\n").filter((line) => line.trim().length > 0).length;
    return `${lines} lines · ${items} items`;
  }, [deferred]);

  return (
    <div className="statusbar">
      <span>{counts}</span>
      <span className="statusbar__spacer" />

      <button
        type="button"
        className="statusbar__btn"
        title="Toggle soft wrap"
        onClick={toggleWrap}
      >
        {wrap ? "wrap" : "trunc"}
      </button>

      <button
        type="button"
        className="statusbar__btn"
        title="Settings"
        aria-label="Settings"
        onClick={() => setSettingsOpen(true)}
      >
        ⚙
      </button>

      {/* Always rendered, dim by default. A save indicator that only exists while saving
          cannot be trusted — you never see it, so you never learn what it means. */}
      <span
        className={
          error ? "savedot savedot--error" : pulse ? "savedot savedot--pulse" : "savedot"
        }
        title={error ?? "saved"}
      />
    </div>
  );
}

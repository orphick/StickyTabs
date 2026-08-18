import { useEffect } from "react";

import { useStore } from "../store/store";

/** Specified at 1.5s. Long enough to read six words and click Undo, short enough not to
 * sit over the text you just moved. */
const TOAST_MS = 1500;

export function Toast() {
  const toast = useStore((s) => s.toast);
  const dismissToast = useStore((s) => s.dismissToast);
  const undoMove = useStore((s) => s.undoMove);
  const pendingExternal = useStore((s) => s.pendingExternal);
  const acceptConflicts = useStore((s) => s.acceptConflicts);
  const hasConflict = pendingExternal.length > 0;

  useEffect(() => {
    // A conflict toast waits for an answer. Auto-dismissing it would drop the only offer
    // to take the on-disk version, leaving the two copies silently diverged.
    if (!toast || hasConflict) return;
    const timer = window.setTimeout(dismissToast, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, dismissToast, hasConflict]);

  if (!toast) return null;

  return (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.undo ? (
        <button type="button" className="toast__undo" onClick={undoMove}>
          Undo
        </button>
      ) : null}
      {hasConflict ? (
        <>
          <button type="button" className="toast__undo" onClick={acceptConflicts}>
            Load from disk
          </button>
          <button type="button" className="toast__undo" onClick={dismissToast}>
            Keep mine
          </button>
        </>
      ) : null}
    </div>
  );
}

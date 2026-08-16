import { useEffect } from "react";

import { useStore } from "../store/store";

/** Specified at 1.5s. Long enough to read six words and click Undo, short enough not to
 * sit over the text you just moved. */
const TOAST_MS = 1500;

export function Toast() {
  const toast = useStore((s) => s.toast);
  const dismissToast = useStore((s) => s.dismissToast);
  const undoMove = useStore((s) => s.undoMove);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismissToast, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;

  return (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.undo ? (
        <button type="button" className="toast__undo" onClick={undoMove}>
          Undo
        </button>
      ) : null}
    </div>
  );
}

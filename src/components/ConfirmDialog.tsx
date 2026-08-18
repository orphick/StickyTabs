import { useEffect, useRef } from "react";

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for `window.confirm`.
 *
 * The native dialog is not usable here: WebView2 script dialogs are unreliable inside a
 * frameless always-on-top window, and a `confirm()` that quietly returns false turns
 * "close this tab" into a button that does nothing at all. Owning the dialog also means it
 * matches the app's theme instead of appearing as a system-styled box.
 */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className="modal__scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        onKeyDown={(event) => {
          // Kept off the global dispatcher: Escape here means "cancel", not "close find".
          event.stopPropagation();
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter") onConfirm();
        }}
      >
        <div className="modal__title">{title}</div>
        <div className="confirm__body">{body}</div>
        <div className="confirm__row">
          <button type="button" className="confirm__btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="confirm__btn confirm__btn--primary"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

interface Props {
  index: number;
  name: string;
  active: boolean;
  dragging: boolean;
  dropSide: "before" | "after" | null;
  onSelect: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
  onDragStart: (clientX: number) => void;
}

export function Tab({
  index,
  name,
  active,
  dragging,
  dropSide,
  onSelect,
  onRename,
  onClose,
  onContextMenu,
  onDragStart,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== name) onRename(trimmed);
    else setDraft(name);
  }

  const className = [
    "tab",
    active ? "tab--active" : "",
    dragging ? "tab--dragging" : "",
    dropSide === "before" ? "tab--dropbefore" : "",
    dropSide === "after" ? "tab--dropafter" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (editing) {
    return (
      <div className={className} title={name} data-tab-index={index}>
        <input
          ref={inputRef}
          className="tab__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // Stopped here so the global dispatcher does not treat typing in this field as
            // an app shortcut.
            event.stopPropagation();
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              setDraft(name);
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={className}
      title={name}
      data-tab-index={index}
      role="tab"
      aria-selected={active}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.button === 0) {
          onSelect();
          onDragStart(event.clientX);
        }
      }}
      onAuxClick={(event) => {
        // Middle-click closes, per the spec.
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
      onDoubleClick={() => {
        setDraft(name);
        setEditing(true);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      {name}
    </div>
  );
}

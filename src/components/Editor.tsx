import { useCallback, useEffect, useRef, useState } from "react";

import type { Match } from "../lib/find";
import { setEditorElement } from "../store/editorRef";
import { useStore } from "../store/store";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { HighlightLayer } from "./HighlightLayer";

interface Props {
  matches: readonly Match[];
  currentMatch: number;
  findOpen: boolean;
  onOpenFind: () => void;
}

export function Editor({ matches, currentMatch, findOpen, onOpenFind }: Props) {
  const activeSlug = useStore((s) => s.activeSlug);
  const text = useStore((s) => (s.activeSlug ? (s.notes[s.activeSlug] ?? "") : ""));
  const wrap = useStore((s) => s.settings.wrap);
  const setText = useStore((s) => s.setText);
  const rememberTabUi = useStore((s) => s.rememberTabUi);

  const areaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Publish the live node so the store's actions can read the selection without routing
  // caret movement through React state.
  useEffect(() => {
    setEditorElement(areaRef.current);
    return () => setEditorElement(null);
  }, []);

  const syncHighlightScroll = useCallback(() => {
    const area = areaRef.current;
    const layer = highlightRef.current;
    if (!area || !layer) return;
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  }, []);

  useEffect(() => {
    if (findOpen) syncHighlightScroll();
  }, [findOpen, matches, currentMatch, syncHighlightScroll]);

  /**
   * Low-frequency safety net for caret persistence.
   *
   * The authoritative saves happen on tab switch, blur and close. This covers the case
   * where the machine dies without any of those firing — the text is already safe via
   * autosave, and this keeps the caret roughly right too. Deliberately not per-keystroke:
   * that would push a store update into the typing path.
   */
  useEffect(() => {
    if (!activeSlug) return;
    const timer = window.setInterval(() => {
      const area = areaRef.current;
      if (!area || document.activeElement !== area) return;
      rememberTabUi(activeSlug, { caret: area.selectionStart, scrollTop: area.scrollTop });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeSlug, rememberTabUi]);

  if (!activeSlug) {
    return (
      <div className="editor">
        <div className="empty">no tabs — press Ctrl+T</div>
      </div>
    );
  }

  return (
    <div className={wrap ? "editor editor--wrap" : "editor editor--nowrap"}>
      {findOpen ? (
        <div ref={highlightRef} className="editor__shared editor__highlight">
          <HighlightLayer text={text} matches={matches} current={currentMatch} />
        </div>
      ) : null}

      <textarea
        ref={areaRef}
        className="editor__shared editor__input"
        value={text}
        wrap={wrap ? "soft" : "off"}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="start typing"
        aria-label="Note text"
        onChange={(event) => {
          const area = event.currentTarget;
          setText(activeSlug, area.value, area.selectionStart, area.selectionEnd);
        }}
        onScroll={syncHighlightScroll}
        onBlur={(event) => {
          rememberTabUi(activeSlug, {
            caret: event.currentTarget.selectionStart,
            scrollTop: event.currentTarget.scrollTop,
          });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      />

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={editorMenuEntries(onOpenFind)}
        />
      ) : null}
    </div>
  );
}

function editorMenuEntries(onOpenFind: () => void): MenuEntry[] {
  const store = useStore.getState;
  return [
    { label: "Undo", hint: "Ctrl+Z", onSelect: () => store().undo() },
    { label: "Redo", hint: "Ctrl+Y", onSelect: () => store().redo() },
    { separator: true },
    { label: "Move line to Report", hint: "Ctrl+Enter", onSelect: () => store().moveLineToReport() },
    { label: "Find…", hint: "Ctrl+F", onSelect: onOpenFind },
    { separator: true },
    {
      label: store().settings.wrap ? "Truncate long lines" : "Wrap long lines",
      onSelect: () => store().toggleWrap(),
    },
    { label: "Larger text", hint: "Ctrl+=", onSelect: () => store().stepFontSize(1) },
    { label: "Smaller text", hint: "Ctrl+-", onSelect: () => store().stepFontSize(-1) },
    { separator: true },
    { label: "Settings…", onSelect: () => store().setSettingsOpen(true) },
  ];
}

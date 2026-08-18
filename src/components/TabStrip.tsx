import { useCallback, useEffect, useRef, useState } from "react";

import { useStore } from "../store/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { tabMenuEntries } from "../lib/tabMenu";
import { ContextMenu } from "./ContextMenu";
import { Tab } from "./Tab";

/** Pointer travel before a press becomes a drag. Below this it is just a click. */
const DRAG_THRESHOLD_PX = 5;

interface DragState {
  index: number;
  startX: number;
  active: boolean;
  overIndex: number | null;
}

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const activeSlug = useStore((s) => s.activeSlug);
  const notes = useStore((s) => s.notes);
  const setActive = useStore((s) => s.setActive);
  const addTab = useStore((s) => s.addTab);
  const renameTab = useStore((s) => s.renameTab);
  const closeTab = useStore((s) => s.closeTab);
  const reorderTabs = useStore((s) => s.reorderTabs);
  const patchSettings = useStore((s) => s.patchSettings);
  const reportSlug = useStore((s) => s.reportSlug());

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  // Value unused: bumping it is only a way to re-render while the drag lives in a ref,
  // which keeps pointermove off React's state path.
  const [, setDragVersion] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; slug: string } | null>(null);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [fades, setFades] = useState({ left: false, right: false });

  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFades({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    updateFades();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateFades);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabs.length, updateFades]);

  // Keep the active tab visible when it changes via keyboard rather than a click.
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(".tab--active");
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateFades();
  }, [activeSlug, updateFades]);

  // Drag-to-reorder. Pointer events rather than HTML5 drag-and-drop: the latter needs a
  // drag image and fires inconsistently inside a frameless WebView2 window.
  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;

      if (!drag.active && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
      drag.active = true;

      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-tab-index]");
      const overIndex = target ? Number(target.dataset["tabIndex"]) : null;

      if (overIndex !== drag.overIndex) {
        drag.overIndex = Number.isFinite(overIndex) ? overIndex : null;
        setDragVersion((v) => v + 1);
      }
    }

    function onUp() {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.active && drag.overIndex !== null && drag.overIndex !== drag.index) {
        reorderTabs(drag.index, drag.overIndex);
      }
      setDragVersion((v) => v + 1);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [reorderTabs]);

  const requestClose = useCallback(
    (slug: string) => {
      // Keep at least one tab. A window with no editor in it has nothing to offer.
      if (tabs.length <= 1) return;
      const text = notes[slug] ?? "";
      // Confirm only when there is something to lose. An empty scratch tab closes silently.
      if (text.trim().length > 0) {
        setPendingClose(slug);
        return;
      }
      void closeTab(slug);
    },
    [closeTab, notes, tabs],
  );

  const drag = dragRef.current;
  const dragActive = drag?.active === true;

  return (
    <div className="tabstrip" onWheelCapture={updateFades}>
      <div
        ref={scrollRef}
        className="tabstrip__scroll"
        role="tablist"
        onScroll={updateFades}
        onWheel={(event) => {
          // A vertical wheel over a horizontal strip should scroll it, not do nothing.
          if (event.deltaY !== 0 && scrollRef.current) {
            scrollRef.current.scrollLeft += event.deltaY;
          }
        }}
      >
        {tabs.map((tab, index) => (
          <Tab
            key={tab.slug}
            index={index}
            name={tab.name}
            active={tab.slug === activeSlug}
            dragging={dragActive && drag?.index === index}
            dropSide={
              dragActive && drag?.overIndex === index && drag.index !== index
                ? drag.index < index
                  ? "after"
                  : "before"
                : null
            }
            onSelect={() => void setActive(tab.slug)}
            onRename={(name) => void renameTab(tab.slug, name)}
            onClose={() => requestClose(tab.slug)}
            onContextMenu={(x, y) => setMenu({ x, y, slug: tab.slug })}
            onDragStart={(clientX) => {
              dragRef.current = { index, startX: clientX, active: false, overIndex: index };
            }}
          />
        ))}
      </div>

      {fades.left ? <div className="tabstrip__fade tabstrip__fade--left" /> : null}
      {fades.right ? <div className="tabstrip__fade tabstrip__fade--right" /> : null}

      <button
        type="button"
        className="tab__add"
        title="New tab (Ctrl+T)"
        aria-label="New tab"
        onClick={() => void addTab()}
      >
        +
      </button>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={tabMenuEntries({
            isReport: menu.slug === reportSlug,
            onRename: () => {
              // Re-enter the tab's inline editor by taking the same path a double-click does.
              const el = document.querySelector<HTMLElement>(
                `[data-tab-index="${tabs.findIndex((t) => t.slug === menu.slug)}"]`,
              );
              el?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            },
            onSetReport: () => patchSettings({ reportSlug: menu.slug }),
            onClose: () => requestClose(menu.slug),
            canClose: tabs.length > 1,
          })}
        />
      ) : null}

      {pendingClose ? (
        <ConfirmDialog
          title="Close tab"
          body={`Close "${tabs.find((t) => t.slug === pendingClose)?.name ?? pendingClose}"?\n\nThe note is moved to the _trash folder, not deleted.`}
          confirmLabel="Close tab"
          onCancel={() => setPendingClose(null)}
          onConfirm={() => {
            const slug = pendingClose;
            setPendingClose(null);
            void closeTab(slug);
          }}
        />
      ) : null}
    </div>
  );
}


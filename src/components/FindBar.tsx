import { useEffect, useRef } from "react";

import type { Match } from "../lib/find";
import { stepMatch } from "../lib/find";
import { getEditorElement } from "../store/editorRef";
import { useStore } from "../store/store";

interface Props {
  matches: readonly Match[];
}

/**
 * Select a match inside the textarea and bring it into view.
 *
 * Selecting rather than merely highlighting is what makes Enter-stepping feel like a real
 * find: the caret ends up on the match, so closing the bar leaves you where you were
 * looking. `setSelectionRange` on a focused textarea scrolls the selection into view.
 *
 * Focus is then handed back to the query field, otherwise the next Enter would go into the
 * note instead of stepping to the next match.
 */
function revealMatch(match: Match | undefined, refocus: HTMLInputElement | null): void {
  const area = getEditorElement();
  if (!area || !match) return;
  area.focus();
  area.setSelectionRange(match.start, match.end);
  refocus?.focus();
}

export function FindBar({ matches }: Props) {
  const find = useStore((s) => s.find);
  const setFind = useStore((s) => s.setFind);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function step(delta: number) {
    if (matches.length === 0) return;
    const next = stepMatch(find.index, matches.length, delta);
    setFind({ index: next });
    revealMatch(matches[next], inputRef.current);
  }

  function close() {
    setFind({ open: false, index: -1 });
    getEditorElement()?.focus();
  }

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        className="findbar__input"
        value={find.query}
        placeholder="find"
        aria-label="Find in note"
        onChange={(event) => setFind({ query: event.target.value, index: -1 })}
        onKeyDown={(event) => {
          // The global dispatcher must not see keys typed into this field.
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />

      <span className="findbar__count">
        {find.query.length === 0
          ? ""
          : matches.length === 0
            ? "no matches"
            : `${find.index >= 0 ? find.index + 1 : 1}/${matches.length}`}
      </span>

      <button
        type="button"
        className={find.caseSensitive ? "findbar__btn findbar__btn--on" : "findbar__btn"}
        title="Match case"
        aria-pressed={find.caseSensitive}
        onClick={() => setFind({ caseSensitive: !find.caseSensitive, index: -1 })}
      >
        Aa
      </button>
      <button type="button" className="findbar__btn" title="Previous (Shift+Enter)" onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" className="findbar__btn" title="Next (Enter)" onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" className="findbar__btn" title="Close (Esc)" onClick={close}>
        ✕
      </button>
    </div>
  );
}

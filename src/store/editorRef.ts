/**
 * A module-level handle on the one live textarea.
 *
 * Selection and scroll position change on every arrow key. Pushing them through React
 * state would re-render the whole window dozens of times a second while the user simply
 * moves the caret, which is exactly the input lag the 5000-line requirement rules out.
 * So they stay in the DOM, and the few actions that need them (the Ctrl+Enter move, find
 * stepping, undo restoration) read them from here.
 */

let element: HTMLTextAreaElement | null = null;

export function setEditorElement(el: HTMLTextAreaElement | null): void {
  element = el;
}

export function getEditorElement(): HTMLTextAreaElement | null {
  return element;
}

/** Current selection, or a zero-width selection at 0 if the editor is not mounted. */
export function readSelection(): { selStart: number; selEnd: number } {
  if (!element) return { selStart: 0, selEnd: 0 };
  return { selStart: element.selectionStart, selEnd: element.selectionEnd };
}

export function readScrollTop(): number {
  return element?.scrollTop ?? 0;
}

/**
 * Put the caret back and scroll it into view.
 *
 * Deferred to the next frame because callers invoke it right after a state change, and
 * React has not written the new `value` to the DOM yet — setting a selection against the
 * old text would land in the wrong place or be clamped away.
 */
export function restoreSelection(selStart: number, selEnd: number, scrollTop?: number): void {
  requestAnimationFrame(() => {
    if (!element) return;
    element.focus();
    element.setSelectionRange(selStart, selEnd);
    if (scrollTop !== undefined) element.scrollTop = scrollTop;
  });
}

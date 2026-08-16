/**
 * The Ctrl+Enter workflow: move a line out of the current tab and into the Report tab,
 * filed under today's date.
 *
 * Kept pure and free of React so the exact text surgery can be unit-tested — this is the
 * one feature that mutates two documents at once, and getting it wrong loses text.
 */

export interface LineRange {
  from: number;
  to: number;
}

/** Matches a date heading. Only these delimit a group; other `##` lines are content. */
const HEADING_RE = /^##\s+\d{4}-\d{2}-\d{2}\s*$/;

/**
 * Expand a selection to whole lines.
 *
 * With no selection (`selStart === selEnd`) this yields the caret's line. With one, it
 * yields every line the selection touches, even partially — moving half a line into the
 * report would be surprising.
 *
 * The returned `to` excludes the trailing newline; [`cutRange`] deals with that, because
 * whether to also swallow the newline depends on where in the document the range sits.
 */
export function lineRangeAt(text: string, selStart: number, selEnd: number): LineRange {
  const start = Math.max(0, Math.min(selStart, selEnd));
  let end = Math.min(text.length, Math.max(selStart, selEnd));

  // A selection that ends just past a newline (dragging to the start of the next line, or
  // a triple-click, which selects the line *and* its break) has not actually touched that
  // next line. Step back over the break so it is not dragged into the move.
  if (end > start && text[end - 1] === "\n") end -= 1;

  const from = text.lastIndexOf("\n", start - 1) + 1;

  let to = text.indexOf("\n", end);
  if (to === -1) to = text.length;

  return { from, to };
}

/**
 * Remove `[from, to)` and the line break that went with it.
 *
 * Takes the *following* newline when there is one, so removing a middle line closes the
 * gap. At end of file there is no following newline, so it takes the preceding one
 * instead — otherwise every move would leave a blank line behind at the bottom.
 */
export function cutRange(text: string, range: LineRange): { text: string; caret: number } {
  let { from, to } = range;

  if (text[to] === "\n") {
    to += 1;
  } else if (from > 0 && text[from - 1] === "\n") {
    from -= 1;
  }

  return { text: text.slice(0, from) + text.slice(to), caret: from };
}

/** The lines a move will take, as an array with no trailing empty entry. */
export function linesIn(text: string, range: LineRange): string[] {
  return text.slice(range.from, range.to).split("\n");
}

/**
 * Append `lines` to `reportText` under a `## YYYY-MM-DD` heading for `isoDate`.
 *
 * - If today's heading exists, the lines go at the *end* of that group, so entries read
 *   oldest-first within a day.
 * - If it does not, the heading is created at the *top* of the file, so the newest date
 *   group is always the first thing visible.
 *
 * Trailing blank lines inside a group are stepped over rather than written past, so
 * repeated moves stay tight against the previous entry instead of drifting down.
 */
export function insertIntoReport(reportText: string, lines: string[], isoDate: string): string {
  const entry = lines.join("\n");
  const heading = `## ${isoDate}`;

  const all = reportText.split("\n");
  const headingIndex = all.findIndex((line) => line.trim() === heading);

  if (headingIndex === -1) {
    const rest = reportText.replace(/^\n+/, "");
    return rest.length > 0
      ? `${heading}\n${entry}\n\n${rest}`
      : `${heading}\n${entry}\n`;
  }

  let groupEnd = all.length;
  for (let i = headingIndex + 1; i < all.length; i += 1) {
    if (HEADING_RE.test(all[i] ?? "")) {
      groupEnd = i;
      break;
    }
  }

  let insertAt = groupEnd;
  while (insertAt > headingIndex + 1 && (all[insertAt - 1] ?? "").trim() === "") {
    insertAt -= 1;
  }

  const next = [...all.slice(0, insertAt), entry, ...all.slice(insertAt)];
  return next.join("\n");
}

/**
 * Pick the Report tab.
 *
 * An explicit choice from settings wins, but only while that tab still exists — a stale
 * `reportSlug` pointing at a closed tab must fall through rather than break the feature.
 * Otherwise: the tab literally named "Report", case-insensitively, as specified.
 */
export function resolveReportSlug(
  tabs: readonly { slug: string; name: string }[],
  configured: string | null,
): string | null {
  if (configured && tabs.some((t) => t.slug === configured)) return configured;
  const byName = tabs.find((t) => t.name.trim().toLowerCase() === "report");
  return byName?.slug ?? null;
}

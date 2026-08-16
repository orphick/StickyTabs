import { memo } from "react";

import type { Match } from "../lib/find";

interface Props {
  text: string;
  matches: readonly Match[];
  current: number;
}

/**
 * Paints the find highlights.
 *
 * A textarea cannot style its own content, so this content sits in a div directly behind
 * it holding the same text with `<mark>` around each hit. The textarea's background is
 * transparent and the two share every metric-affecting CSS property via `.editor__shared`,
 * so the marks land exactly under the glyphs.
 *
 * Returns bare children rather than its own element: the wrapper is the scroll container
 * the editor keeps in sync, and a second padded box here would offset every mark.
 *
 * Rendered only while the find bar is open — otherwise every keystroke in a 5000-line note
 * would re-render a second full copy of the document.
 */
export const HighlightLayer = memo(function HighlightLayer({ text, matches, current }: Props) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  matches.forEach((match, index) => {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start));
    parts.push(
      <mark key={match.start} className={index === current ? "now" : undefined}>
        {text.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  });
  parts.push(text.slice(cursor));

  // The trailing newline matches the textarea's implicit final blank line, keeping the two
  // scroll heights identical.
  return (
    <>
      {parts}
      {"\n"}
    </>
  );
});

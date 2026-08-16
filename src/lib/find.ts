/** Match ranges for the find bar. Plain substring search — the spec asks for find, not regex. */

export interface Match {
  start: number;
  end: number;
}

/** Cap on matches. A one-character query against a 5000-line note would otherwise produce
 * hundreds of thousands of DOM nodes in the highlight layer and freeze the window. */
const MAX_MATCHES = 2000;

export function findMatches(text: string, query: string, caseSensitive: boolean): Match[] {
  if (query.length === 0) return [];

  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();

  const matches: Match[] = [];
  let from = 0;
  while (matches.length < MAX_MATCHES) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    matches.push({ start: index, end: index + needle.length });
    // Advance past the whole match: overlapping hits ("aa" in "aaa") would double-count.
    from = index + needle.length;
  }
  return matches;
}

/** Index of the first match at or after `caret`, wrapping to 0. `-1` when there are none. */
export function matchAfter(matches: readonly Match[], caret: number): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((m) => m.start >= caret);
  return index === -1 ? 0 : index;
}

/** Step through matches with wraparound in both directions. */
export function stepMatch(current: number, total: number, delta: number): number {
  if (total === 0) return -1;
  return (current + delta + total) % total;
}

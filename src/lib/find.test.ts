import { describe, expect, it } from "vitest";

import { findMatches, matchAfter, stepMatch } from "./find";

describe("findMatches", () => {
  it("finds every occurrence", () => {
    expect(findMatches("aXbXc", "X", true)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  it("ignores case by default", () => {
    expect(findMatches("Alpha alpha", "ALPHA", false)).toHaveLength(2);
    expect(findMatches("Alpha alpha", "ALPHA", true)).toHaveLength(0);
  });

  it("returns nothing for an empty query", () => {
    expect(findMatches("anything", "", false)).toEqual([]);
  });

  it("does not double-count overlapping runs", () => {
    expect(findMatches("aaaa", "aa", true)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("treats the query as literal text, not a regex", () => {
    expect(findMatches("a.c abc", ".", true)).toEqual([{ start: 1, end: 2 }]);
  });

  it("caps the match count so a one-character query cannot freeze the window", () => {
    expect(findMatches("x".repeat(5000), "x", true).length).toBeLessThanOrEqual(2000);
  });
});

describe("matchAfter", () => {
  const matches = [
    { start: 10, end: 12 },
    { start: 40, end: 42 },
  ];

  it("picks the first match at or after the caret", () => {
    expect(matchAfter(matches, 0)).toBe(0);
    expect(matchAfter(matches, 20)).toBe(1);
  });

  it("wraps to the top when the caret is past the last match", () => {
    expect(matchAfter(matches, 500)).toBe(0);
  });

  it("returns -1 when there is nothing to select", () => {
    expect(matchAfter([], 0)).toBe(-1);
  });
});

describe("stepMatch", () => {
  it("wraps in both directions", () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
  });

  it("steps from nothing selected to the first match", () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
  });

  it("returns -1 when there are no matches", () => {
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});

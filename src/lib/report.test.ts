import { describe, expect, it } from "vitest";

import { cutRange, insertIntoReport, lineRangeAt, linesIn, resolveReportSlug } from "./report";

const DAY = "2026-08-16";

describe("lineRangeAt", () => {
  it("takes the caret's whole line when there is no selection", () => {
    const text = "alpha\nbravo\ncharlie";
    const range = lineRangeAt(text, 8, 8); // inside "bravo"
    expect(text.slice(range.from, range.to)).toBe("bravo");
  });

  it("takes every line a selection touches, even partially", () => {
    const text = "alpha\nbravo\ncharlie";
    const range = lineRangeAt(text, 3, 8); // "ha\nbr"
    expect(text.slice(range.from, range.to)).toBe("alpha\nbravo");
  });

  it("handles the first and last lines", () => {
    const text = "alpha\nbravo";
    expect(linesIn(text, lineRangeAt(text, 0, 0))).toEqual(["alpha"]);
    expect(linesIn(text, lineRangeAt(text, 11, 11))).toEqual(["bravo"]);
  });

  it("does not drag in the next line when a selection ends at a line start", () => {
    // What a triple-click gives you: the line plus its trailing newline.
    const text = "alpha\nbravo\ncharlie";
    expect(linesIn(text, lineRangeAt(text, 0, 6))).toEqual(["alpha"]);
  });

  it("moving a triple-clicked line leaves the rest intact", () => {
    const text = "alpha\nbravo\ncharlie";
    expect(cutRange(text, lineRangeAt(text, 0, 6)).text).toBe("bravo\ncharlie");
  });
});

describe("cutRange", () => {
  it("closes the gap when removing a middle line", () => {
    const text = "alpha\nbravo\ncharlie";
    expect(cutRange(text, lineRangeAt(text, 8, 8)).text).toBe("alpha\ncharlie");
  });

  it("leaves no trailing blank line when removing the last line", () => {
    const text = "alpha\nbravo";
    expect(cutRange(text, lineRangeAt(text, 8, 8)).text).toBe("alpha");
  });

  it("puts the caret where the removed line started", () => {
    const text = "alpha\nbravo\ncharlie";
    expect(cutRange(text, lineRangeAt(text, 8, 8)).caret).toBe(6);
  });

  it("empties a single-line document cleanly", () => {
    const text = "only";
    expect(cutRange(text, lineRangeAt(text, 2, 2)).text).toBe("");
  });
});

describe("insertIntoReport", () => {
  it("creates today's heading in an empty report", () => {
    expect(insertIntoReport("", ["did a thing"], DAY)).toBe("## 2026-08-16\ndid a thing\n");
  });

  it("puts a new date group at the TOP, above older ones", () => {
    const existing = "## 2026-08-15\nyesterday\n";
    expect(insertIntoReport(existing, ["today"], DAY)).toBe(
      "## 2026-08-16\ntoday\n\n## 2026-08-15\nyesterday\n",
    );
  });

  it("appends under an existing heading rather than duplicating it", () => {
    const existing = "## 2026-08-16\nfirst\n";
    const result = insertIntoReport(existing, ["second"], DAY);
    expect(result).toBe("## 2026-08-16\nfirst\nsecond\n");
    expect(result.match(/## 2026-08-16/g)).toHaveLength(1);
  });

  it("appends to today's group without disturbing older groups below", () => {
    const existing = "## 2026-08-16\nfirst\n\n## 2026-08-15\nold\n";
    expect(insertIntoReport(existing, ["second"], DAY)).toBe(
      "## 2026-08-16\nfirst\nsecond\n\n## 2026-08-15\nold\n",
    );
  });

  it("steps over trailing blank lines instead of drifting down the file", () => {
    const existing = "## 2026-08-16\nfirst\n\n\n";
    expect(insertIntoReport(existing, ["second"], DAY)).toBe("## 2026-08-16\nfirst\nsecond\n\n\n");
  });

  it("keeps multi-line moves together", () => {
    expect(insertIntoReport("", ["one", "two"], DAY)).toBe("## 2026-08-16\none\ntwo\n");
  });

  it("does not mistake a non-date ## line for a heading", () => {
    const existing = "## 2026-08-16\nfirst\n## not a date\nnote\n";
    expect(insertIntoReport(existing, ["second"], DAY)).toBe(
      "## 2026-08-16\nfirst\n## not a date\nnote\nsecond\n",
    );
  });

  it("finds today's heading even when it is not the first group", () => {
    const existing = "## 2026-08-17\ntomorrow\n\n## 2026-08-16\ntoday\n";
    expect(insertIntoReport(existing, ["more"], DAY)).toBe(
      "## 2026-08-17\ntomorrow\n\n## 2026-08-16\ntoday\nmore\n",
    );
  });
});

describe("resolveReportSlug", () => {
  const tabs = [
    { slug: "schedule", name: "Schedule" },
    { slug: "report", name: "Report" },
  ];

  it("defaults to the tab literally named Report", () => {
    expect(resolveReportSlug(tabs, null)).toBe("report");
  });

  it("is case-insensitive on the name", () => {
    expect(resolveReportSlug([{ slug: "r", name: "  report " }], null)).toBe("r");
  });

  it("prefers an explicit setting", () => {
    expect(resolveReportSlug(tabs, "schedule")).toBe("schedule");
  });

  it("falls back when the configured tab no longer exists", () => {
    expect(resolveReportSlug(tabs, "deleted")).toBe("report");
  });

  it("returns null when there is no candidate", () => {
    expect(resolveReportSlug([{ slug: "a", name: "A" }], null)).toBeNull();
  });
});

describe("a full move, end to end", () => {
  it("removes the line from the source and files it under today", () => {
    const source = "buy milk\ncall the bank\nfix the sink";
    const report = "## 2026-08-15\nold entry\n";

    const range = lineRangeAt(source, 12, 12); // inside "call the bank"
    const lines = linesIn(source, range);
    const cut = cutRange(source, range);

    expect(lines).toEqual(["call the bank"]);
    expect(cut.text).toBe("buy milk\nfix the sink");
    expect(insertIntoReport(report, lines, DAY)).toBe(
      "## 2026-08-16\ncall the bank\n\n## 2026-08-15\nold entry\n",
    );
  });
});

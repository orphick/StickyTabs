import { describe, expect, it } from "vitest";

import { conflictMessage, planExternalChanges, reloadMessage } from "./externalChanges";

const tabs = [
  { slug: "schedule", name: "Schedule" },
  { slug: "report", name: "Report" },
];

function plan(
  changes: { slug: string; name: string; text: string }[],
  notes: Record<string, string>,
  dirty: string[] = [],
) {
  return planExternalChanges({
    changes,
    tabs,
    notes,
    isDirty: (slug) => dirty.includes(slug),
  });
}

describe("planExternalChanges", () => {
  it("reloads a clean tab whose file changed", () => {
    const result = plan(
      [{ slug: "schedule", name: "Schedule", text: "edited in Notepad" }],
      { schedule: "old", report: "" },
    );
    expect(result.reload.map((c) => c.slug)).toEqual(["schedule"]);
    expect(result.conflicts).toEqual([]);
  });

  // The bug this whole feature exists for: unsaved keystrokes must never be silently
  // replaced by what happens to be on disk.
  it("never overwrites a tab with unsaved edits", () => {
    const result = plan(
      [{ slug: "schedule", name: "Schedule", text: "edited in Notepad" }],
      { schedule: "half-typed sentence" },
      ["schedule"],
    );
    expect(result.reload).toEqual([]);
    expect(result.conflicts.map((c) => c.slug)).toEqual(["schedule"]);
  });

  it("ignores a change whose text already matches what is loaded", () => {
    const result = plan([{ slug: "schedule", name: "Schedule", text: "same" }], {
      schedule: "same",
    });
    expect(result).toEqual({ reload: [], adopt: [], conflicts: [] });
  });

  it("adopts a .txt dropped into the folder as a new tab", () => {
    const result = plan([{ slug: "shopping", name: "Shopping", text: "milk" }], {});
    expect(result.adopt).toEqual([{ slug: "shopping", name: "Shopping", text: "milk" }]);
    expect(result.reload).toEqual([]);
  });

  it("does not treat an unknown slug as a conflict even while dirty elsewhere", () => {
    const result = plan(
      [{ slug: "shopping", name: "Shopping", text: "milk" }],
      { schedule: "typing" },
      ["schedule"],
    );
    expect(result.conflicts).toEqual([]);
    expect(result.adopt).toHaveLength(1);
  });

  it("splits a mixed batch into reload and conflict", () => {
    const result = plan(
      [
        { slug: "schedule", name: "Schedule", text: "A" },
        { slug: "report", name: "Report", text: "B" },
      ],
      { schedule: "old-a", report: "old-b" },
      ["report"],
    );
    expect(result.reload.map((c) => c.slug)).toEqual(["schedule"]);
    expect(result.conflicts.map((c) => c.slug)).toEqual(["report"]);
  });
});

describe("messages", () => {
  it("names a single note but counts several", () => {
    expect(reloadMessage(["Schedule"])).toBe("Schedule reloaded from disk");
    expect(reloadMessage(["Schedule", "Report"])).toBe("2 notes reloaded from disk");
    expect(conflictMessage(["Report"])).toBe("Report also changed on disk");
    expect(conflictMessage(["A", "B", "C"])).toBe("3 notes also changed on disk");
  });
});

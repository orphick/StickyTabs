import { describe, expect, it, vi } from "vitest";

import { tabMenuEntries } from "./tabMenu";

function labels(entries: ReturnType<typeof tabMenuEntries>): string[] {
  return entries.flatMap((entry) => ("separator" in entry ? [] : [entry.label]));
}

const noop = () => {};

function build(overrides: Partial<Parameters<typeof tabMenuEntries>[0]> = {}) {
  return tabMenuEntries({
    isReport: false,
    canClose: true,
    onRename: noop,
    onSetReport: noop,
    onClose: noop,
    ...overrides,
  });
}

describe("tabMenuEntries", () => {
  it("offers only tab-scoped actions", () => {
    expect(labels(build())).toEqual(["Rename", "Use as Report tab", "Close tab"]);
  });

  it("does not offer Settings — that belongs to the editor menu", () => {
    expect(labels(build()).some((label) => label.startsWith("Settings"))).toBe(false);
  });

  it("invokes onClose when Close tab is selected", () => {
    const onClose = vi.fn();
    const entry = build({ onClose }).find(
      (e) => !("separator" in e) && e.label === "Close tab",
    );
    if (!entry || "separator" in entry) throw new Error("Close tab entry missing");
    entry.onSelect();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables Close tab when it is the last tab", () => {
    const entry = build({ canClose: false }).find(
      (e) => !("separator" in e) && e.label === "Close tab",
    );
    if (!entry || "separator" in entry) throw new Error("Close tab entry missing");
    expect(entry.disabled).toBe(true);
  });

  it("marks the Report tab and disables re-selecting it", () => {
    const entry = build({ isReport: true }).find(
      (e) => !("separator" in e) && e.label === "Is the Report tab",
    );
    if (!entry || "separator" in entry) throw new Error("Report entry missing");
    expect(entry.disabled).toBe(true);
  });
});

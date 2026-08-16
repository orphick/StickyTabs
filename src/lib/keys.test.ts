import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleKeyDown } from "./keys";
import { useStore } from "../store/store";
import { DEFAULT_SETTINGS } from "../storage/types";

// The dispatcher is the one place where a typo silently disables a shortcut — nothing
// throws, the key just does nothing. These tests drive the real store, with only the
// Tauri boundary and the live DOM node stubbed out.

vi.mock("../storage/api", () => ({
  localDateISO: () => "2026-08-16",
  loadWorkspace: vi.fn(),
  saveNote: vi.fn().mockResolvedValue(undefined),
  saveTabs: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  createNote: vi.fn(async (name: string) => name.toLowerCase().replace(/\s+/g, "-")),
  renameNote: vi.fn(),
  trashNote: vi.fn().mockResolvedValue(undefined),
  openNotesFolder: vi.fn(),
  setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
  showMainWindow: vi.fn(),
  quitApp: vi.fn(),
}));

vi.mock("../storage/autosave", () => ({
  queueNote: vi.fn(),
  queueTabs: vi.fn(),
  queueSettings: vi.fn(),
  cancelNote: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  hasPendingWrites: () => false,
  onSaved: () => () => undefined,
  onSaveError: () => () => undefined,
}));

/** Caret position the fake editor reports; individual tests move it. */
let caret = 0;

vi.mock("../store/editorRef", () => ({
  setEditorElement: vi.fn(),
  getEditorElement: () => null,
  readSelection: () => ({ selStart: caret, selEnd: caret }),
  readScrollTop: () => 0,
  restoreSelection: vi.fn(),
}));

interface FakeKey {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
}

let prevented = false;

function press({ key, ctrl = true, shift = false }: FakeKey): void {
  prevented = false;
  const event = {
    key,
    ctrlKey: ctrl,
    metaKey: false,
    shiftKey: shift,
    preventDefault: () => {
      prevented = true;
    },
  };
  handleKeyDown(event as unknown as KeyboardEvent);
}

/** Let the async store actions (which await flushAll) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  caret = 0;
  useStore.setState({
    ready: true,
    loadError: null,
    notesDir: "",
    tabs: [
      { slug: "schedule", name: "Schedule" },
      { slug: "queue", name: "Queue" },
      { slug: "report", name: "Report" },
      { slug: "snippets", name: "Snippets" },
    ],
    notes: { schedule: "buy milk\ncall the bank", queue: "", report: "", snippets: "" },
    activeSlug: "schedule",
    settings: { ...DEFAULT_SETTINGS, perTab: {} },
    histories: {},
    find: { open: false, query: "", caseSensitive: false, index: -1 },
    toast: null,
    settingsOpen: false,
  });
});

describe("Ctrl+1..9", () => {
  it("jumps to a tab by position", async () => {
    press({ key: "3" });
    await settle();
    expect(useStore.getState().activeSlug).toBe("report");
    expect(prevented).toBe(true);
  });

  it("handles the first tab", async () => {
    useStore.setState({ activeSlug: "snippets" });
    press({ key: "1" });
    await settle();
    expect(useStore.getState().activeSlug).toBe("schedule");
  });

  it("does nothing when that position has no tab", async () => {
    press({ key: "9" });
    await settle();
    expect(useStore.getState().activeSlug).toBe("schedule");
  });

  it("ignores a plain digit with no modifier", async () => {
    press({ key: "3", ctrl: false });
    await settle();
    expect(useStore.getState().activeSlug).toBe("schedule");
    expect(prevented).toBe(false);
  });
});

describe("Ctrl+Tab", () => {
  it("cycles forward and wraps", async () => {
    press({ key: "Tab" });
    await settle();
    expect(useStore.getState().activeSlug).toBe("queue");

    useStore.setState({ activeSlug: "snippets" });
    press({ key: "Tab" });
    await settle();
    expect(useStore.getState().activeSlug).toBe("schedule");
  });

  it("cycles backward with Shift", async () => {
    press({ key: "Tab", shift: true });
    await settle();
    expect(useStore.getState().activeSlug).toBe("snippets");
  });
});

describe("other shortcuts", () => {
  it("Ctrl+T adds a tab and focuses it", async () => {
    press({ key: "t" });
    await settle();
    const state = useStore.getState();
    expect(state.tabs).toHaveLength(5);
    expect(state.tabs[4]?.name).toBe("Untitled");
    expect(state.activeSlug).toBe("untitled");
  });

  it("Ctrl+T numbers repeat tabs so the strip stays readable", async () => {
    press({ key: "t" });
    await settle();
    press({ key: "t" });
    await settle();
    expect(useStore.getState().tabs[5]?.name).toBe("Untitled 2");
  });

  it("Ctrl+F opens the find bar", () => {
    press({ key: "f" });
    expect(useStore.getState().find.open).toBe(true);
  });

  it("Escape closes the find bar", () => {
    press({ key: "f" });
    press({ key: "Escape", ctrl: false });
    expect(useStore.getState().find.open).toBe(false);
  });

  it("Escape closes the settings modal first", () => {
    useStore.setState({ settingsOpen: true, find: { open: true, query: "", caseSensitive: false, index: -1 } });
    press({ key: "Escape", ctrl: false });
    expect(useStore.getState().settingsOpen).toBe(false);
    expect(useStore.getState().find.open).toBe(true);
  });

  it("Ctrl+= and Ctrl+- step the font size within bounds", () => {
    press({ key: "-" });
    expect(useStore.getState().settings.fontSize).toBe(13);
    press({ key: "-" });
    expect(useStore.getState().settings.fontSize).toBe(13);
    press({ key: "=" });
    expect(useStore.getState().settings.fontSize).toBe(14);
  });

  it("Ctrl+Enter moves the caret's line to the Report tab", () => {
    caret = 2; // inside "buy milk"
    press({ key: "Enter" });

    const state = useStore.getState();
    expect(state.notes["schedule"]).toBe("call the bank");
    expect(state.notes["report"]).toBe("## 2026-08-16\nbuy milk\n");
    expect(state.toast?.undo).not.toBeNull();
  });

  it("Undo on the toast puts the line back exactly", () => {
    caret = 2;
    press({ key: "Enter" });
    useStore.getState().undoMove();

    const state = useStore.getState();
    expect(state.notes["schedule"]).toBe("buy milk\ncall the bank");
    expect(state.notes["report"]).toBe("");
    expect(state.toast).toBeNull();
  });

  it("Ctrl+Z undoes a typed edit, Ctrl+Y redoes it", () => {
    useStore.getState().setText("schedule", "buy milk\ncall the bank!", 21, 21);
    press({ key: "z" });
    expect(useStore.getState().notes["schedule"]).toBe("buy milk\ncall the bank");
    press({ key: "y" });
    expect(useStore.getState().notes["schedule"]).toBe("buy milk\ncall the bank!");
  });

  it("undo history is per tab and survives a tab switch", async () => {
    useStore.getState().setText("schedule", "edited schedule", 0, 0);
    press({ key: "2" });
    await settle();
    useStore.getState().setText("queue", "edited queue", 0, 0);

    press({ key: "z" });
    expect(useStore.getState().notes["queue"]).toBe("");
    expect(useStore.getState().notes["schedule"]).toBe("edited schedule");

    press({ key: "1" });
    await settle();
    press({ key: "z" });
    expect(useStore.getState().notes["schedule"]).toBe("buy milk\ncall the bank");
  });
});

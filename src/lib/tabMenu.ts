import type { MenuEntry } from "../components/ContextMenu";

/**
 * Entries for a tab's right-click menu.
 *
 * Deliberately only tab-scoped actions. Settings lives on the editor's menu; offering it
 * here too made the tab menu look like a general app menu.
 */
export function tabMenuEntries(options: {
  isReport: boolean;
  canClose: boolean;
  onRename: () => void;
  onSetReport: () => void;
  onClose: () => void;
}): MenuEntry[] {
  return [
    { label: "Rename", hint: "dbl-click", onSelect: options.onRename },
    {
      label: options.isReport ? "Is the Report tab" : "Use as Report tab",
      disabled: options.isReport,
      onSelect: options.onSetReport,
    },
    { separator: true },
    {
      label: "Close tab",
      hint: "mid-click",
      disabled: !options.canClose,
      onSelect: options.onClose,
    },
  ];
}

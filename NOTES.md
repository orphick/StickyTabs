# Deliberate deviations from the spec

Everything else is as written. These are the places I chose differently, and why.

1. **`settings.json` is a second file, alongside `tabs.json`.**
   The spec says `tabs.json` holds *only* order, names, and the active tab — but it also
   requires caret and scroll position to survive a restart, and those have to live
   somewhere. Splitting them keeps `tabs.json` exactly as specified and trivially
   hand-editable. Theme, font size, wrap, always-on-top and the Report tab live there too.

2. **Undo/redo is a hand-written stack, not the browser's.**
   The spec allows either. The native textarea stack is owned by the DOM node, so it dies
   on unmount and is blind to programmatic edits — the Ctrl+Enter move would be invisible
   to it. `src/store/history.ts` keeps per-tab past/future stacks with time- and
   newline-based coalescing, and `Ctrl+Z`/`Ctrl+Y` are intercepted so the native stack is
   never consulted.

3. **One textarea, not one per tab.**
   The spec suggests keeping tabs mounted as one way to preserve undo. Point 2 removes
   that need, so the editor mounts a single textarea and swaps its value. With 5000-line
   notes, eight mounted textareas is DOM we never have to pay for.

4. **Storage is Rust, not `tauri-plugin-fs`.**
   The plugin has no fsync-then-rename, which is the entire point of the durability
   requirement. `src-tauri/src/storage.rs` writes to a temp file in the same directory,
   `sync_all()`s it, then renames over the target — and retries the rename, because
   Defender and the Windows Search indexer transiently lock newly created files and would
   otherwise make autosave drop writes at random on a real machine.

5. **Close-to-tray is handled in JavaScript, not Rust.**
   Preventing the close in Rust would race the pending autosave. The frontend intercepts
   `onCloseRequested`, awaits `flushAll()`, saves the window geometry, and only then
   hides. Tray "Quit" takes the same path via an event, with a 1.5s deadline in Rust so a
   wedged webview cannot make the app unquittable.

6. **Window geometry is saved on every hide, not only on exit.**
   `tauri-plugin-window-state` saves on clean exit. This app lives in the tray, where a
   reboot never reaches that path, so position and size would silently reset. The plugin's
   VISIBLE and ALWAYS_ON_TOP flags are also disabled: a session that ended hidden would
   otherwise restore hidden, and always-on-top is owned by `settings.json`. Relatedly, the
   window is centred from Rust only when no saved geometry exists — `"center": true` in
   `tauri.conf.json` runs on *every* launch and silently beats the restore, which is what
   made the window forget its position in testing.

7. **The visual-direction mockup's four additions are in.**
   A status bar with `N lines · N items`; a permanently dimmed saved-dot that brightens on
   write (an indicator you only ever see when it appears cannot be trusted); a 1px edge
   fade so an overflowing tab strip reads as continuing; and right-click menus on the tab
   strip and the editor, since there is nowhere else to put font size and theme.

8. **Report headings use the spec's `## YYYY-MM-DD`,** not the mockup's `2026-08-16 Sun`.
   The date comes from the frontend's *local* date, not `toISOString()`, which would file
   an evening entry under yesterday for anyone west of Greenwich.

9. **Notepad round-trips are normalised.** A UTF-8 BOM is stripped and CRLF collapsed to
   LF on read; writes are always LF with no BOM. Without this a BOM shows as a stray glyph
   at offset 0 and every stored caret offset is wrong.

10. **Tab names are numbered.** New tabs are "Untitled", "Untitled 2", … Two tabs both
    reading "Untitled" are indistinguishable on the strip even though their files differ.

11. **The last tab cannot be closed.** A window with no editor in it has nothing to offer.

12. **Slugs are sanitised against Windows reserved device names.** A tab named "con" or
    "aux" would otherwise be uncreatable — `CON.txt` is the console, not a file.

13. **Single-instance, and the global hotkey is best-effort.**
    Not in the spec, but required to make it work. Because the app lives hidden in the
    tray, relaunching it is the obvious way a user tries to get it back — and a second
    process cannot register `Ctrl+Shift+N`, so it died on startup and left the app
    unreachable without Task Manager. A second launch now hands the window back to the
    running copy, and hotkey registration failure is logged rather than fatal.

---

# What was verified, and how

**Automated** — 65 frontend tests (`npm test`) and 23 Rust tests (`cargo test`), all
passing, plus a clean `tsc --noEmit`, `eslint`, and production build.

The Rust tests cover the durability requirements directly: a short write replacing a
longer one leaves no tail behind; no `.tmp` survives a completed write; `tabs.json` being
deleted *and* being half-written both rebuild from the `.txt` files; an orphan `.txt` is
adopted; an entry whose file vanished is dropped; a BOM+CRLF file round-trips to LF;
closing the same slug twice keeps both copies in `_trash`; path traversal is refused.

The frontend tests cover the Ctrl+Enter text surgery exhaustively (heading creation at the
top, appending under an existing heading without duplicating it, multi-line moves,
triple-click selections, `##` lines that are not dates), the undo coalescing rules, and the
keyboard dispatcher driving the real store — including `Ctrl+1..9` and `Ctrl+Tab`.

**Live, against the running app and the real filesystem:**

- First run created exactly four tabs; `report.txt` was byte-for-byte
  `23 23 20 32 30 32 36 2D 30 38 2D 31 36 0A` — `## 2026-08-16\n`, no BOM, LF.
- Typing three lines produced exactly those bytes in `schedule.txt`, no wrapper.
- `Ctrl+Enter` moved `call the bank` out of `schedule.txt` and into `report.txt` under
  today's heading; a second move appended under the *same* heading rather than duplicating
  it.
- Deleting `tabs.json`, adding an orphan `shopping-list.txt`, and restarting rebuilt the
  tab list from the folder and adopted the orphan as "Shopping List" — no dialog.
- `WM_CLOSE` left the process alive with the window hidden; `Ctrl+Shift+N` toggled it back
  and hidden again.
- Both installers build: `StickyTabs_1.0.0_x64_en-US.msi` (1.66 MB) and
  `StickyTabs_1.0.0_x64-setup.exe` (1.16 MB).

**Not verified live:** the tray icon's menu items, drag-to-reorder, inline rename, and the
find bar's visual highlighting all need real mouse input or a human eye on the window, and
synthetic input proved unreliable against WebView2. Their logic is unit-tested where it is
pure (find matching, report insertion, key dispatch); the DOM wiring is not.

One measurement I did not take: the "startup to typeable in under 1 second" and "5000-line
tab without input lag" targets are designed for — a single IPC round trip on load, a
deferred line counter, the highlight layer mounted only while find is open — but I have
not profiled them on this machine.

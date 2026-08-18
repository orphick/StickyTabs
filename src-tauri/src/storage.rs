//! Storage layer.
//!
//! Everything the app persists lives under one folder and is written by the functions in
//! this file. Nothing else in the codebase touches the filesystem.
//!
//! ```text
//! %APPDATA%\StickyTabs\
//!   tabs.json              tab order, display names, last active tab — nothing else
//!   settings.json          theme, font size, wrap, always-on-top, report tab,
//!                          and per-tab caret/scroll position
//!   notes\
//!     <slug>.txt           the raw text of one tab. No wrapper, no metadata, no BOM.
//!     _trash\
//!       <slug>.txt         closed tabs. Nothing is ever deleted by the app.
//! ```
//!
//! Two invariants drive every design decision here:
//!
//! 1. **A `.txt` file is the note.** It must open in Notepad, survive a hand edit, and
//!    load back unchanged. That rules out any envelope format and forces the encoding
//!    normalisation in [`read_note_file`].
//!
//! 2. **Power loss is assumed, not feared.** Every write goes through [`atomic_write`],
//!    which fsyncs a temp file and then renames it over the target. A note is therefore
//!    always either its old contents or its new contents — never a truncated mix. The
//!    JSON sidecars are written the same way, and on top of that are *reconstructible*:
//!    if `tabs.json` is lost or garbled, [`load_workspace`] rebuilds it by scanning the
//!    notes folder instead of asking the user anything.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::slug::{is_safe_slug, unique_slug};

/// Bumped only if the on-disk JSON shape changes incompatibly. A file carrying an
/// unknown version is treated exactly like a corrupt one: ignored, then rebuilt.
const SCHEMA_VERSION: u32 = 1;

/// How many times to retry the final rename in [`atomic_write`].
///
/// This is not paranoia. On Windows, Defender's real-time scanner and the Search indexer
/// routinely hold a transient handle on a file that was created microseconds ago, and
/// `MoveFileEx` then fails with `ERROR_ACCESS_DENIED` (os error 5) or `ERROR_SHARING_VIOLATION`
/// (os error 32). Without a retry, autosave randomly drops a write on a real machine.
const RENAME_ATTEMPTS: u32 = 6;

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabEntry {
    /// Filename stem under `notes\`. Stable for the life of the tab unless it is renamed.
    pub slug: String,
    /// What the user sees on the tab. Free-form; may contain anything, including
    /// characters no filesystem would accept.
    pub name: String,
}

/// `tabs.json` — deliberately minimal. Order, names, active tab. If you are tempted to
/// add a field here, it probably belongs in `settings.json` instead.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsFile {
    pub version: u32,
    pub active_slug: Option<String>,
    pub tabs: Vec<TabEntry>,
}

/// Where the caret and viewport were left in one tab. Restored on tab switch *and* on
/// app restart, which is why it has to be persisted rather than kept in memory.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TabUiState {
    pub caret: usize,
    pub scroll_top: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    /// `"dark"` or `"light"`. Kept as a string so an unknown value degrades to the
    /// default instead of failing the whole parse.
    pub theme: String,
    pub font_size: u32,
    pub wrap: bool,
    pub always_on_top: bool,
    /// Slug of the tab that `Ctrl+Enter` appends to. `None` means "resolve by name at
    /// runtime", which is how the default 'a tab literally named Report' works.
    pub report_slug: Option<String>,
    /// BTreeMap rather than HashMap so the file has a stable key order and diffs cleanly
    /// if the user version-controls their notes folder.
    pub per_tab: BTreeMap<String, TabUiState>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            theme: "dark".to_string(),
            font_size: 14,
            wrap: true,
            always_on_top: true,
            report_slug: None,
            per_tab: BTreeMap::new(),
        }
    }
}

/// Everything the frontend needs to render, in one payload.
///
/// Startup is a single IPC round trip on purpose: the sub-1s cold-start budget does not
/// survive one `invoke` per tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub tabs: Vec<TabEntry>,
    pub active_slug: Option<String>,
    /// slug -> full text. Loaded eagerly; these are text notes, not a database.
    pub notes: BTreeMap<String, String>,
    pub settings: Settings,
    /// Shown in the settings modal so the user knows exactly where their data is.
    pub notes_dir: String,
    /// True when this run created the seed tabs. The frontend uses it only to decide
    /// whether to focus the editor immediately.
    pub first_run: bool,
    /// True when `tabs.json` was missing or unusable and had to be rebuilt from the
    /// `.txt` files. Surfaced for logging only — the spec forbids prompting the user.
    pub recovered: bool,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Root data directory: `%APPDATA%\StickyTabs`.
///
/// `STICKYTABS_DATA_DIR` overrides it. That exists for the tests in this file, which need
/// a throwaway directory, and it doubles as an escape hatch for a portable install.
pub fn root_dir() -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("STICKYTABS_DATA_DIR") {
        if !custom.is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "APPDATA is not set; cannot locate the notes folder".to_string())?;
    Ok(PathBuf::from(appdata).join("StickyTabs"))
}

pub fn notes_dir() -> Result<PathBuf, String> {
    Ok(root_dir()?.join("notes"))
}

pub fn trash_dir() -> Result<PathBuf, String> {
    Ok(notes_dir()?.join("_trash"))
}

fn tabs_path() -> Result<PathBuf, String> {
    Ok(root_dir()?.join("tabs.json"))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(root_dir()?.join("settings.json"))
}

fn note_path(slug: &str) -> Result<PathBuf, String> {
    // Every filesystem-touching entry point funnels through here, so this one check is
    // enough to make path traversal from the frontend impossible.
    if !is_safe_slug(slug) {
        return Err(format!("refusing to use unsafe slug {slug:?}"));
    }
    Ok(notes_dir()?.join(format!("{slug}.txt")))
}

/// Creates the folder tree if it is missing. Cheap enough to call before any write.
pub fn ensure_dirs() -> Result<(), String> {
    let trash = trash_dir()?;
    fs::create_dir_all(&trash).map_err(|e| format!("cannot create {}: {e}", trash.display()))
}

// ---------------------------------------------------------------------------
// Atomic write — the core of the durability guarantee
// ---------------------------------------------------------------------------

/// Write `contents` to `path` such that a crash or power cut at any instant leaves
/// `path` holding either its previous contents or the new ones, never a partial write.
///
/// The sequence matters:
///
/// 1. Write to `<path>.tmp` **in the same directory**. A rename is only atomic within a
///    single volume, so the temp file cannot live in `%TEMP%`.
/// 2. `sync_all()` — flush the file's data *and* metadata to the physical device before
///    the rename. Skipping this is the classic mistake: the rename can reach the disk
///    before the data does, and a power cut then leaves a file that has been atomically
///    replaced with zero bytes. That is strictly worse than not writing at all.
/// 3. `fs::rename` over the target. On Windows this compiles to `MoveFileExW` with
///    `MOVEFILE_REPLACE_EXISTING`, which is atomic and overwrites, so there is no
///    delete-then-rename window where the note does not exist.
/// 4. Retry the rename against transient AV/indexer locks (see [`RENAME_ATTEMPTS`]).
///
/// On total failure the temp file is left on disk rather than cleaned up: it holds the
/// user's most recent text, and this module's job is to never destroy text.
fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");

    {
        let mut f = File::create(&tmp)
            .map_err(|e| format!("cannot create temp file {}: {e}", tmp.display()))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("cannot flush {} to disk: {e}", tmp.display()))?;
        // `f` is dropped here, closing the handle. The rename below would fail on Windows
        // if it were still open.
    }

    let mut last_err = String::new();
    for attempt in 0..RENAME_ATTEMPTS {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                // Linear backoff: 0ms, 15ms, 30ms … Long enough for a scanner to let go,
                // short enough that a 400ms autosave debounce never notices.
                std::thread::sleep(Duration::from_millis(u64::from(attempt) * 15));
            }
        }
    }

    Err(format!(
        "could not replace {} after {RENAME_ATTEMPTS} attempts: {last_err} \
         (your text is safe in {})",
        path.display(),
        tmp.display()
    ))
}

// ---------------------------------------------------------------------------
// Note text I/O
// ---------------------------------------------------------------------------

/// Read one note, normalising whatever an external editor may have left behind.
///
/// Notepad and friends will happily add a UTF-8 BOM and CRLF line endings. Both must be
/// stripped on the way in, or the BOM shows up as a stray glyph at offset 0 and every
/// caret offset in `settings.json` is off by one per line. We always write back LF
/// without a BOM; modern Notepad renders that correctly.
///
/// Invalid UTF-8 is replaced rather than rejected — a note that is 99% readable must
/// still open.
fn read_note_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

/// List the slugs of every `.txt` directly inside `notes\`.
///
/// `_trash\` is a subdirectory and so is skipped for free. Files whose stem is not a
/// legal slug (dropped in by hand, e.g. `My Note.txt`) are ignored rather than adopted —
/// adopting them would mean renaming the user's file behind their back.
fn scan_note_slugs() -> Result<Vec<String>, String> {
    let dir = notes_dir()?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new()); // First run: the folder does not exist yet.
    };

    let mut slugs: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue; // Skips leftover .tmp files from an interrupted write.
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if is_safe_slug(stem) {
                slugs.push(stem.to_string());
            }
        }
    }
    slugs.sort();
    Ok(slugs)
}

// ---------------------------------------------------------------------------
// Sidecar JSON I/O
// ---------------------------------------------------------------------------

/// Read `tabs.json`, or `None` if it is absent, unreadable, unparseable, or from a
/// schema version this build does not understand.
///
/// Every failure mode collapses to `None` on purpose. The caller's recovery path is the
/// same regardless of *why* the file was unusable, and the notes themselves are the
/// source of truth anyway.
fn read_tabs_file() -> Option<TabsFile> {
    let path = tabs_path().ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let parsed: TabsFile = serde_json::from_str(&raw).ok()?;
    if parsed.version != SCHEMA_VERSION {
        return None;
    }
    Some(parsed)
}

/// Read `settings.json`, falling back to defaults on any problem. Settings are a
/// convenience, never a blocker: a corrupt settings file must not stop the app booting.
fn read_settings_file() -> Settings {
    let Ok(path) = settings_path() else {
        return Settings::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Settings::default();
    };
    match serde_json::from_str::<Settings>(&raw) {
        Ok(s) if s.version == SCHEMA_VERSION => s,
        _ => Settings::default(),
    }
}

fn write_tabs_file(tabs: &TabsFile) -> Result<(), String> {
    ensure_dirs()?;
    let json = serde_json::to_string_pretty(tabs).map_err(|e| e.to_string())?;
    atomic_write(&tabs_path()?, &json)
}

fn write_settings_file(settings: &Settings) -> Result<(), String> {
    ensure_dirs()?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    atomic_write(&settings_path()?, &json)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Load (and if necessary repair) the entire workspace.
///
/// `today` is an ISO `YYYY-MM-DD` string supplied by the frontend so this module needs no
/// clock or timezone dependency — the browser already knows the user's local date, and
/// the seeded Report heading must match the one `Ctrl+Enter` will look for later.
///
/// Recovery algorithm, run on every start (not just after a crash):
///
/// - Take the tab list from `tabs.json` if it parsed, otherwise start empty.
/// - Drop entries whose `.txt` has disappeared. The tab is gone; the text was already
///   gone before we got here.
/// - Append, alphabetically, every `.txt` in the folder that no entry claims. This is the
///   path that rebuilds a deleted `tabs.json`, and it is also how a file dropped into the
///   folder by hand becomes a tab.
/// - If the result is still empty, seed the four default tabs.
///
/// The user is never asked anything. There is no "restore?" dialog because there is
/// never a decision to make: the `.txt` files are the truth.
#[tauri::command]
pub fn load_workspace(today: String) -> Result<Workspace, String> {
    ensure_dirs()?;

    let on_disk = scan_note_slugs()?;
    let stored = read_tabs_file();
    let had_valid_tabs_file = stored.is_some();

    let mut tabs: Vec<TabEntry> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    if let Some(file) = &stored {
        for entry in &file.tabs {
            // Guard against a hand-edited tabs.json containing a hostile or duplicate slug.
            if !is_safe_slug(&entry.slug) || seen.contains(&entry.slug) {
                continue;
            }
            if on_disk.contains(&entry.slug) {
                seen.push(entry.slug.clone());
                tabs.push(entry.clone());
            }
        }
    }

    // Adopt orphans. `on_disk` is already sorted, so recovery order is deterministic.
    let mut adopted_orphan = false;
    for slug in &on_disk {
        if !seen.contains(slug) {
            adopted_orphan = true;
            seen.push(slug.clone());
            tabs.push(TabEntry {
                slug: slug.clone(),
                // Best-effort display name; the user can rename it in one double-click.
                name: prettify_slug(slug),
            });
        }
    }

    let first_run = tabs.is_empty();
    if first_run {
        tabs = seed_default_tabs(&today)?;
    }

    // Read every note. Four small text files; this is microseconds, and it means the UI
    // has no per-tab loading state to get wrong.
    let mut notes: BTreeMap<String, String> = BTreeMap::new();
    for tab in &tabs {
        let path = note_path(&tab.slug)?;
        let text = read_note_file(&path).unwrap_or_default();
        notes.insert(tab.slug.clone(), text);
    }

    // Keep the stored active tab if it still exists, else fall back to the first.
    let active_slug = stored
        .as_ref()
        .and_then(|f| f.active_slug.clone())
        .filter(|s| tabs.iter().any(|t| &t.slug == s))
        .or_else(|| tabs.first().map(|t| t.slug.clone()));

    let mut settings = read_settings_file();
    // Drop per-tab UI state for tabs that no longer exist, so settings.json cannot grow
    // without bound over years of use.
    settings.per_tab.retain(|slug, _| seen.contains(slug) || first_run);

    let recovered = !had_valid_tabs_file || adopted_orphan;

    // Persist the repaired view immediately. If the app is killed a second later, the
    // next start has a clean tabs.json rather than repeating the same scan.
    let repaired = TabsFile {
        version: SCHEMA_VERSION,
        active_slug: active_slug.clone(),
        tabs: tabs.clone(),
    };
    write_tabs_file(&repaired)?;

    Ok(Workspace {
        tabs,
        active_slug,
        notes,
        settings,
        notes_dir: notes_dir()?.to_string_lossy().to_string(),
        first_run,
        recovered,
    })
}

/// `my-notes-2` -> `My Notes 2`. Only used for orphan `.txt` files, where no display name
/// was ever recorded.
pub fn prettify_slug(slug: &str) -> String {
    slug.split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// First-run content: Schedule, Queue, Report, Snippets — all empty except Report, which
/// gets today's heading so `Ctrl+Enter` has something to append under from minute one.
fn seed_default_tabs(today: &str) -> Result<Vec<TabEntry>, String> {
    let defaults: [(&str, String); 4] = [
        ("Schedule", String::new()),
        ("Queue", String::new()),
        ("Report", format!("## {today}\n")),
        ("Snippets", String::new()),
    ];

    let mut tabs = Vec::new();
    let mut taken: Vec<String> = Vec::new();
    for (name, text) in defaults {
        let slug = unique_slug(name, &taken);
        atomic_write(&note_path(&slug)?, &text)?;
        taken.push(slug.clone());
        tabs.push(TabEntry {
            slug,
            name: name.to_string(),
        });
    }
    Ok(tabs)
}

/// Persist one note. Called by the debounced autosave and by every forced flush.
#[tauri::command]
pub fn save_note(slug: String, text: String) -> Result<(), String> {
    ensure_dirs()?;
    atomic_write(&note_path(&slug)?, &text)?;
    // Tell the watcher this content came from us, so it does not report our own save back
    // to the frontend as an external edit.
    crate::watcher::note_written(&slug, &text);
    Ok(())
}

/// Read one note's text. Used by the watcher when a file changes underneath us.
pub fn read_note(slug: &str) -> Result<String, String> {
    read_note_file(&note_path(slug)?)
}

#[tauri::command]
pub fn save_tabs(tabs: Vec<TabEntry>, active_slug: Option<String>) -> Result<(), String> {
    write_tabs_file(&TabsFile {
        version: SCHEMA_VERSION,
        active_slug,
        tabs,
    })
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    write_settings_file(&settings)
}

/// Create the `.txt` for a new tab and hand back the slug it was given.
///
/// Uniqueness is resolved against what is actually on disk, not against what the
/// frontend thinks exists, so a stale renderer state cannot cause two tabs to share a
/// file.
#[tauri::command]
pub fn create_note(name: String) -> Result<String, String> {
    ensure_dirs()?;
    let taken = scan_note_slugs()?;
    let slug = unique_slug(&name, &taken);
    atomic_write(&note_path(&slug)?, "")?;
    crate::watcher::note_written(&slug, "");
    Ok(slug)
}

/// Rename a tab: move `<old>.txt` to a slug derived from the new display name.
///
/// Renaming the file keeps the notes folder readable from Explorer, which is the whole
/// point of a plain-text store. If the new name slugs to the same value (e.g. "Report" ->
/// "report "), the file is left alone and the old slug is returned.
#[tauri::command]
pub fn rename_note(slug: String, new_name: String) -> Result<String, String> {
    ensure_dirs()?;
    let from = note_path(&slug)?;

    let taken: Vec<String> = scan_note_slugs()?.into_iter().filter(|s| s != &slug).collect();
    let new_slug = unique_slug(&new_name, &taken);
    if new_slug == slug {
        return Ok(slug);
    }

    let to = note_path(&new_slug)?;
    // Read-write-remove rather than `fs::rename`, so an interruption leaves both files
    // rather than neither. The stale copy would simply be re-adopted as an orphan tab on
    // the next start — recoverable, whereas a lost file is not.
    let text = read_note_file(&from).unwrap_or_default();
    atomic_write(&to, &text)?;
    let _ = fs::remove_file(&from);
    // Both halves of the rename are ours; neither should come back as an external edit.
    crate::watcher::note_written(&new_slug, &text);
    crate::watcher::note_forgotten(&slug);
    Ok(new_slug)
}

/// Close a tab: move its `.txt` into `notes\_trash\` instead of deleting it.
///
/// A same-named file already in the trash is suffixed with a unix timestamp rather than
/// overwritten — closing "scratch" twice must not lose the first one.
#[tauri::command]
pub fn trash_note(slug: String) -> Result<(), String> {
    ensure_dirs()?;
    let from = note_path(&slug)?;
    if !from.exists() {
        return Ok(());
    }

    let mut to = trash_dir()?.join(format!("{slug}.txt"));
    if to.exists() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        to = trash_dir()?.join(format!("{slug}-{stamp}.txt"));
    }

    let text = read_note_file(&from).unwrap_or_default();
    atomic_write(&to, &text)?;
    // A file later reappearing at this slug is somebody else's doing, not our echo.
    crate::watcher::note_forgotten(&slug);
    fs::remove_file(&from).map_err(|e| format!("cannot remove {}: {e}", from.display()))
}

/// Reveal the notes folder in Explorer.
#[tauri::command]
pub fn open_notes_folder() -> Result<(), String> {
    let dir = notes_dir()?;
    ensure_dirs()?;
    std::process::Command::new("explorer.exe")
        .arg(dir.as_os_str())
        .spawn()
        // explorer.exe returns a non-zero exit code even on success, so we only care that
        // the process started at all.
        .map(|_| ())
        .map_err(|e| format!("cannot open {}: {e}", dir.display()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// The data directory is process-global state (an env var), so the tests that touch
    /// it have to run one at a time even though cargo runs tests in parallel.
    fn lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    struct TempRoot {
        path: PathBuf,
        _guard: MutexGuard<'static, ()>,
    }

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let guard = lock();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("stickytabs-test-{tag}-{nanos}"));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            std::env::set_var("STICKYTABS_DATA_DIR", &path);
            Self { path, _guard: guard }
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            std::env::remove_var("STICKYTABS_DATA_DIR");
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn note_text(root: &Path, slug: &str) -> String {
        fs::read_to_string(root.join("notes").join(format!("{slug}.txt"))).unwrap()
    }

    #[test]
    fn first_run_seeds_four_tabs_with_report_heading() {
        let t = TempRoot::new("seed");
        let ws = load_workspace("2026-08-16".to_string()).unwrap();

        assert!(ws.first_run);
        let names: Vec<&str> = ws.tabs.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["Schedule", "Queue", "Report", "Snippets"]);
        assert_eq!(note_text(&t.path, "report"), "## 2026-08-16\n");
        assert_eq!(note_text(&t.path, "queue"), "");
        assert_eq!(ws.active_slug.as_deref(), Some("schedule"));
    }

    #[test]
    fn note_file_holds_raw_text_and_nothing_else() {
        let t = TempRoot::new("raw");
        load_workspace("2026-08-16".to_string()).unwrap();
        save_note("queue".to_string(), "line one\nline two".to_string()).unwrap();
        // Byte-for-byte: no BOM, no wrapper, no trailing newline we did not ask for.
        let bytes = fs::read(t.path.join("notes/queue.txt")).unwrap();
        assert_eq!(bytes, b"line one\nline two");
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_behind() {
        let t = TempRoot::new("tmp");
        load_workspace("2026-08-16".to_string()).unwrap();
        save_note("queue".to_string(), "hello".to_string()).unwrap();
        assert!(!t.path.join("notes/queue.tmp").exists());
        assert_eq!(note_text(&t.path, "queue"), "hello");
    }

    #[test]
    fn atomic_write_replaces_rather_than_truncates() {
        let t = TempRoot::new("replace");
        load_workspace("2026-08-16".to_string()).unwrap();
        save_note("queue".to_string(), "aaaaaaaaaa".to_string()).unwrap();
        // A shorter second write must not leave the tail of the first behind — which is
        // exactly what an in-place rewrite without truncation would do.
        save_note("queue".to_string(), "bb".to_string()).unwrap();
        assert_eq!(note_text(&t.path, "queue"), "bb");
    }

    #[test]
    fn missing_tabs_json_is_rebuilt_from_txt_files() {
        let t = TempRoot::new("missing");
        load_workspace("2026-08-16".to_string()).unwrap();
        save_note("queue".to_string(), "keep me".to_string()).unwrap();

        fs::remove_file(t.path.join("tabs.json")).unwrap();

        let ws = load_workspace("2026-08-16".to_string()).unwrap();
        assert!(ws.recovered);
        assert!(!ws.first_run);
        assert_eq!(ws.tabs.len(), 4);
        assert_eq!(ws.notes.get("queue").map(String::as_str), Some("keep me"));
        // And it was written back, so the next start is clean.
        assert!(t.path.join("tabs.json").exists());
    }

    #[test]
    fn corrupt_tabs_json_is_rebuilt_from_txt_files() {
        let t = TempRoot::new("corrupt");
        load_workspace("2026-08-16".to_string()).unwrap();
        save_note("snippets".to_string(), "still here".to_string()).unwrap();

        // A half-written file is the realistic corruption, not random bytes.
        fs::write(t.path.join("tabs.json"), "{\"version\":1,\"tabs\":[{\"slu").unwrap();

        let ws = load_workspace("2026-08-16".to_string()).unwrap();
        assert!(ws.recovered);
        assert_eq!(ws.tabs.len(), 4);
        assert_eq!(ws.notes.get("snippets").map(String::as_str), Some("still here"));
    }

    #[test]
    fn orphan_txt_dropped_in_by_hand_becomes_a_tab() {
        let t = TempRoot::new("orphan");
        load_workspace("2026-08-16".to_string()).unwrap();
        fs::write(t.path.join("notes/shopping-list.txt"), "milk\neggs").unwrap();

        let ws = load_workspace("2026-08-16".to_string()).unwrap();
        assert!(ws.recovered);
        let shopping = ws.tabs.iter().find(|x| x.slug == "shopping-list").unwrap();
        assert_eq!(shopping.name, "Shopping List");
        assert_eq!(ws.notes.get("shopping-list").map(String::as_str), Some("milk\neggs"));
    }

    #[test]
    fn tabs_json_entry_without_a_file_is_dropped() {
        let t = TempRoot::new("ghost");
        load_workspace("2026-08-16".to_string()).unwrap();
        fs::remove_file(t.path.join("notes/queue.txt")).unwrap();

        let ws = load_workspace("2026-08-16".to_string()).unwrap();
        assert_eq!(ws.tabs.len(), 3);
        assert!(!ws.tabs.iter().any(|x| x.slug == "queue"));
    }

    #[test]
    fn notepad_crlf_and_bom_round_trip_to_lf() {
        let t = TempRoot::new("notepad");
        load_workspace("2026-08-16".to_string()).unwrap();
        // Exactly what Notepad writes when "UTF-8 with BOM" is selected.
        fs::write(
            t.path.join("notes/queue.txt"),
            b"\xEF\xBB\xBFone\r\ntwo\r\n".as_slice(),
        )
        .unwrap();

        let ws = load_workspace("2026-08-16".to_string()).unwrap();
        assert_eq!(ws.notes.get("queue").map(String::as_str), Some("one\ntwo\n"));
    }

    #[test]
    fn closing_a_tab_moves_the_file_to_trash() {
        let t = TempRoot::new("trash");
        load_workspace("2026-08-16".to_string()).unwrap();
        save_note("snippets".to_string(), "precious".to_string()).unwrap();

        trash_note("snippets".to_string()).unwrap();

        assert!(!t.path.join("notes/snippets.txt").exists());
        assert_eq!(
            fs::read_to_string(t.path.join("notes/_trash/snippets.txt")).unwrap(),
            "precious"
        );
    }

    #[test]
    fn trashing_the_same_slug_twice_keeps_both() {
        let t = TempRoot::new("trash2");
        load_workspace("2026-08-16".to_string()).unwrap();
        save_note("queue".to_string(), "first".to_string()).unwrap();
        trash_note("queue".to_string()).unwrap();

        let slug = create_note("Queue".to_string()).unwrap();
        save_note(slug.clone(), "second".to_string()).unwrap();
        trash_note(slug).unwrap();

        let kept: Vec<String> = fs::read_dir(t.path.join("notes/_trash"))
            .unwrap()
            .flatten()
            .map(|e| fs::read_to_string(e.path()).unwrap())
            .collect();
        assert_eq!(kept.len(), 2);
        assert!(kept.contains(&"first".to_string()));
        assert!(kept.contains(&"second".to_string()));
    }

    #[test]
    fn renaming_moves_the_file_and_keeps_the_text() {
        let t = TempRoot::new("rename");
        load_workspace("2026-08-16".to_string()).unwrap();
        save_note("queue".to_string(), "watchlist".to_string()).unwrap();

        let new_slug = rename_note("queue".to_string(), "Watch Later".to_string()).unwrap();

        assert_eq!(new_slug, "watch-later");
        assert!(!t.path.join("notes/queue.txt").exists());
        assert_eq!(note_text(&t.path, "watch-later"), "watchlist");
    }

    #[test]
    fn new_tabs_never_share_a_file() {
        let _t = TempRoot::new("collide");
        load_workspace("2026-08-16".to_string()).unwrap();
        let a = create_note("Report".to_string()).unwrap();
        let b = create_note("report!".to_string()).unwrap();
        assert_ne!(a, "report");
        assert_ne!(a, b);
    }

    #[test]
    fn unsafe_slugs_are_refused() {
        let _t = TempRoot::new("unsafe");
        load_workspace("2026-08-16".to_string()).unwrap();
        assert!(save_note("../../evil".to_string(), "x".to_string()).is_err());
        assert!(save_note("..".to_string(), "x".to_string()).is_err());
        assert!(trash_note("C:evil".to_string()).is_err());
    }

    #[test]
    fn settings_survive_a_round_trip_and_prune_dead_tabs() {
        let _t = TempRoot::new("settings");
        load_workspace("2026-08-16".to_string()).unwrap();

        let mut s = Settings::default();
        s.theme = "light".to_string();
        s.font_size = 15;
        s.per_tab.insert("queue".to_string(), TabUiState { caret: 12, scroll_top: 40.0 });
        s.per_tab.insert("gone".to_string(), TabUiState::default());
        save_settings(s).unwrap();

        let ws = load_workspace("2026-08-16".to_string()).unwrap();
        assert_eq!(ws.settings.theme, "light");
        assert_eq!(ws.settings.font_size, 15);
        assert_eq!(ws.settings.per_tab.get("queue").unwrap().caret, 12);
        assert!(ws.settings.per_tab.get("gone").is_none());
    }

    #[test]
    fn corrupt_settings_json_does_not_block_startup() {
        let t = TempRoot::new("badsettings");
        load_workspace("2026-08-16".to_string()).unwrap();
        fs::write(t.path.join("settings.json"), "not json at all").unwrap();

        let ws = load_workspace("2026-08-16".to_string()).unwrap();
        assert_eq!(ws.settings.theme, "dark");
        assert_eq!(ws.tabs.len(), 4);
    }

    #[test]
    fn leftover_tmp_files_are_not_adopted_as_tabs() {
        let t = TempRoot::new("leftover");
        load_workspace("2026-08-16".to_string()).unwrap();
        // Simulates a power cut between the temp write and the rename.
        fs::write(t.path.join("notes/queue.tmp"), "half written").unwrap();

        let ws = load_workspace("2026-08-16".to_string()).unwrap();
        assert_eq!(ws.tabs.len(), 4);
        assert!(!ws.tabs.iter().any(|x| x.slug == "queue.tmp"));
    }
}

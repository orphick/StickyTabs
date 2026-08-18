//! Watches `notes\` so an edit made in another program is not silently thrown away.
//!
//! Without this the frontend holds text loaded at startup and never re-reads it, so
//! editing a note in Notepad while StickyTabs is running works right up until you touch
//! that tab in the app — at which point autosave writes the stale in-memory copy back over
//! your file. Since the whole premise is "these are ordinary text files you can edit
//! anywhere", that was the one bug that contradicted the product.
//!
//! Two things make this safe to run alongside autosave:
//!
//! 1. **Our own writes are filtered out.** Every write records a hash of what it wrote;
//!    an event whose file still hashes to that value is our own echo and is dropped.
//!    Without this the app would reload itself on every keystroke's save.
//! 2. **Events are debounced.** A single save can produce several notifications (the temp
//!    file, the rename, a metadata touch), and editors often write in bursts.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::storage;

/// Quiet period before changes are reported. Long enough to coalesce an editor's
/// multi-step save, short enough that a reload still feels immediate.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Emitted with the notes that changed underneath us.
pub const EVENT_NOTES_CHANGED: &str = "stickytabs://notes-changed";

/// Hash of the text this app last wrote for each slug, used to recognise our own echoes.
fn last_written() -> &'static Mutex<HashMap<String, u64>> {
    static MAP: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hash_text(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Record what we just wrote, so the resulting filesystem event can be ignored.
pub fn note_written(slug: &str, text: &str) {
    if let Ok(mut map) = last_written().lock() {
        map.insert(slug.to_string(), hash_text(text));
    }
}

/// Forget a slug, so a file reappearing at that name is treated as a genuine change.
pub fn note_forgotten(slug: &str) {
    if let Ok(mut map) = last_written().lock() {
        map.remove(slug);
    }
}

/// True when `text` is exactly what this app last wrote for `slug`.
fn is_own_echo(slug: &str, text: &str) -> bool {
    last_written()
        .lock()
        .ok()
        .and_then(|map| map.get(slug).copied())
        .is_some_and(|hash| hash == hash_text(text))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteChange {
    pub slug: String,
    /// Suggested tab name, used only when this slug is not open yet.
    pub name: String,
    pub text: String,
}

/// Start watching in the background. Failure is non-fatal: the app still works, it just
/// loses live reload, which is not worth refusing to start over.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(error) = run(app) {
            eprintln!("StickyTabs: notes watcher stopped: {error}");
        }
    });
}

fn run(app: AppHandle) -> Result<(), String> {
    let dir = storage::notes_dir()?;
    storage::ensure_dirs()?;

    let (tx, rx) = mpsc::channel();
    let mut watcher = RecommendedWatcher::new(
        move |result| {
            let _ = tx.send(result);
        },
        Config::default(),
    )
    .map_err(|e| format!("cannot create watcher: {e}"))?;

    // Non-recursive: `_trash\` is a subdirectory and its churn is not interesting.
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("cannot watch {}: {e}", dir.display()))?;

    loop {
        // Block until something happens, then keep draining for DEBOUNCE so a burst of
        // events from one save collapses into a single reload.
        let Ok(first) = rx.recv() else {
            return Ok(()); // Sender dropped: app is shutting down.
        };

        let mut touched: HashSet<String> = HashSet::new();
        collect(first, &mut touched);
        while let Ok(event) = rx.recv_timeout(DEBOUNCE) {
            collect(event, &mut touched);
        }

        let mut changes = Vec::new();
        for slug in touched {
            match storage::read_note(&slug) {
                // Removed, or unreadable. Deliberately not reported: the in-memory text is
                // the only surviving copy at that point, and the next save restores the
                // file. Dropping the tab here would turn a stray delete into data loss.
                Err(_) => continue,
                Ok(text) => {
                    if is_own_echo(&slug, &text) {
                        continue;
                    }
                    // Adopt the new text as the known state, so one external edit is
                    // reported once rather than on every subsequent event.
                    note_written(&slug, &text);
                    changes.push(NoteChange {
                        name: storage::prettify_slug(&slug),
                        slug,
                        text,
                    });
                }
            }
        }

        if !changes.is_empty() {
            let _ = app.emit(EVENT_NOTES_CHANGED, changes);
        }
    }
}

/// Pull the slugs of any `.txt` mentioned by an event into `touched`.
fn collect(result: notify::Result<notify::Event>, touched: &mut HashSet<String>) {
    let Ok(event) = result else { return };
    if matches!(event.kind, EventKind::Access(_)) {
        return; // Reads are not changes.
    }
    for path in &event.paths {
        if let Some(slug) = slug_of(path) {
            touched.insert(slug);
        }
    }
}

/// `…\notes\schedule.txt` -> `schedule`. Ignores our own `.tmp` files and anything that is
/// not a plain `.txt`.
fn slug_of(path: &Path) -> Option<String> {
    if path.extension()?.to_str()? != "txt" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    if stem.is_empty() {
        return None;
    }
    Some(stem.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_of_accepts_plain_txt() {
        assert_eq!(slug_of(Path::new(r"C:\notes\schedule.txt")).as_deref(), Some("schedule"));
    }

    #[test]
    fn slug_of_rejects_temp_and_other_extensions() {
        assert_eq!(slug_of(Path::new(r"C:\notes\schedule.txt.tmp")), None);
        assert_eq!(slug_of(Path::new(r"C:\notes\tabs.json")), None);
        assert_eq!(slug_of(Path::new(r"C:\notes")), None);
    }

    #[test]
    fn own_writes_are_recognised_as_echoes() {
        note_written("echo-demo", "hello");
        assert!(is_own_echo("echo-demo", "hello"));
        assert!(!is_own_echo("echo-demo", "hello, world"));
    }

    #[test]
    fn forgetting_a_slug_makes_its_next_write_foreign() {
        note_written("forget-demo", "text");
        assert!(is_own_echo("forget-demo", "text"));
        note_forgotten("forget-demo");
        assert!(!is_own_echo("forget-demo", "text"));
    }
}

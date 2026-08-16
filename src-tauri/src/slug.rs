//! Filename derivation.
//!
//! A tab's display name is arbitrary user text; a filename is not. This module is the
//! single place that translates one into the other, so every path the app touches is
//! guaranteed legal on Windows.

/// Device names Windows reserves at *every* directory level. `CON.txt` is not a file —
/// it is the console. Creating one fails, and worse, opening one can hang. A user who
/// names a tab "con" or "aux" must still get a working note.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Longest slug we will emit. Kept well under MAX_PATH so that
/// `%APPDATA%\StickyTabs\notes\_trash\<slug>.txt` cannot overflow even for a user with a
/// long profile name.
const MAX_LEN: usize = 64;

/// Turn a display name into a bare slug (no extension, no uniqueness guarantee).
///
/// Lowercases, replaces every character outside `[a-z0-9_-]` with `-`, collapses runs of
/// `-`, and trims them from the ends. Non-ASCII input (e.g. a tab named "ノート") collapses
/// to nothing, which is why the empty case falls back to `note` rather than erroring —
/// `tabs.json` keeps the real display name, so nothing is lost to the user.
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;

    for ch in name.trim().chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }

    let mut s = out.trim_matches('-').to_string();

    if s.len() > MAX_LEN {
        s.truncate(MAX_LEN);
        s = s.trim_matches('-').to_string();
    }

    if s.is_empty() {
        s = "note".to_string();
    }

    // Suffix rather than reject: `con` becomes `con-note`, which is a real file and still
    // reads sensibly if the user opens the folder.
    if RESERVED.contains(&s.as_str()) {
        s.push_str("-note");
    }

    s
}

/// `slugify`, then disambiguate against slugs already in use.
///
/// `taken` is every slug currently owned by a tab. Collisions get `-2`, `-3`, … Without
/// this, two tabs named "Notes" and "notes!" would silently share one file and one of the
/// two would lose all of its text on the next save.
pub fn unique_slug(name: &str, taken: &[String]) -> String {
    let base = slugify(name);
    if !taken.iter().any(|t| t == &base) {
        return base;
    }
    for n in 2..10_000 {
        let candidate = format!("{base}-{n}");
        if !taken.iter().any(|t| t == &candidate) {
            return candidate;
        }
    }
    // Practically unreachable; still better than looping forever.
    format!("{base}-{}", std::process::id())
}

/// Guard for slugs arriving from the frontend. Every command that takes a slug runs it
/// through this before touching the filesystem, so a malformed or hostile value
/// (`..\..\Windows\System32\config`) can never escape the notes directory.
pub fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= MAX_LEN + 8
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && !RESERVED.contains(&slug)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_slugs() {
        assert_eq!(slugify("Report"), "report");
        assert_eq!(slugify("My Notes"), "my-notes");
        assert_eq!(slugify("  spaced  out  "), "spaced-out");
        assert_eq!(slugify("a///b"), "a-b");
        assert_eq!(slugify("Q4 — plan (draft)"), "q4-plan-draft");
    }

    #[test]
    fn empty_and_unicode_fall_back() {
        assert_eq!(slugify(""), "note");
        assert_eq!(slugify("!!!"), "note");
        assert_eq!(slugify("ノート"), "note");
    }

    #[test]
    fn reserved_names_are_escaped() {
        assert_eq!(slugify("CON"), "con-note");
        assert_eq!(slugify("nul"), "nul-note");
        assert_eq!(slugify("com4"), "com4-note");
        // Only exact matches are reserved.
        assert_eq!(slugify("console"), "console");
    }

    #[test]
    fn length_is_capped() {
        let long = "x".repeat(200);
        assert_eq!(slugify(&long).len(), MAX_LEN);
    }

    #[test]
    fn collisions_get_suffixes() {
        let taken = vec!["notes".to_string(), "notes-2".to_string()];
        assert_eq!(unique_slug("Notes", &taken), "notes-3");
        assert_eq!(unique_slug("notes!", &taken), "notes-3");
        assert_eq!(unique_slug("Other", &taken), "other");
    }

    #[test]
    fn traversal_is_rejected() {
        assert!(is_safe_slug("report"));
        assert!(is_safe_slug("a-2"));
        assert!(!is_safe_slug(""));
        assert!(!is_safe_slug(".."));
        assert!(!is_safe_slug("../evil"));
        assert!(!is_safe_slug("a\\b"));
        assert!(!is_safe_slug("a/b"));
        assert!(!is_safe_slug("C:evil"));
        assert!(!is_safe_slug("Report")); // uppercase never produced by slugify
        assert!(!is_safe_slug("con"));
    }
}

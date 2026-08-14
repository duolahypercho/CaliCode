//! Whether a file changed since the agent last looked at it.
//!
//! `file_edit` cannot be made blind — it requires text that matches exactly,
//! and you cannot quote a file you have not read. `file_write` has no such
//! protection: it replaces the whole file, so an agent that read a file, spent
//! twenty turns doing something else, and then wrote it back silently destroys
//! everything that changed in between. The user's own editor, a `git pull`, a
//! dev server's formatter, or a second agent all produce that shape.
//!
//! Claude Code enforces read-before-edit in the harness and detects the stale
//! case. The obvious port needs per-session read tracking, and
//! `execute_core_tool_with_activity` has no session identity — which is why
//! this keys on the *file* instead. That turns out to be the better key: the
//! question "did this change since it was read" is about the file, not about
//! who read it, and keying this way also catches edits made outside CaliCode
//! entirely.
//!
//! Only ever a *refusal to overwrite*. Nothing here blocks reading, and nothing
//! blocks an edit that names its own context, because those already carry their
//! own proof.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Files tracked before the oldest entries are forgotten.
///
/// A bound rather than a leak: core is long-lived, and a `/loop` touches a lot
/// of files. Forgetting is safe — an unremembered file is treated as "never
/// read", which permits the write rather than refusing it.
const MAX_TRACKED: usize = 512;

type Registry = HashMap<PathBuf, (u64, u64)>;

/// path -> (content hash, sequence number for eviction order)
fn registry() -> &'static Mutex<(Registry, u64)> {
    static REGISTRY: OnceLock<Mutex<(Registry, u64)>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new((HashMap::new(), 0)))
}

fn hash(content: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

fn key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Remember the file as it is on disk right now.
///
/// Called after a read *and* after a write: an agent's own write is not a
/// change it needs warning about, and without recording it the second write to
/// one file in a turn would be refused.
pub fn remember(path: &Path) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    let Ok(mut guard) = registry().lock() else {
        return;
    };
    let (map, seq) = &mut *guard;
    *seq += 1;
    let stamp = *seq;
    map.insert(key(path), (hash(&bytes), stamp));
    evict_oldest(map);
}

/// Keep the registry bounded by dropping the least recently recorded entry.
///
/// Split out so the bound can be tested against a local map. Filling the real
/// one to prove it evicts also evicts whatever *other* tests had recorded,
/// which is a cross-module flake that looks like the guard failing.
fn evict_oldest(map: &mut Registry) {
    if map.len() <= MAX_TRACKED {
        return;
    }
    if let Some(oldest) = map
        .iter()
        .min_by_key(|(_, (_, stamp))| *stamp)
        .map(|(path, _)| path.clone())
    {
        map.remove(&oldest);
    }
}

/// Did this file change since it was last read or written through core?
///
/// `false` when it was never seen: an unread file has no stale mental model to
/// protect, and refusing there would block the ordinary case of creating one.
pub fn changed_since_seen(path: &Path) -> bool {
    let Ok(guard) = registry().lock() else {
        return false;
    };
    let Some((seen, _)) = guard.0.get(&key(path)) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(path) else {
        // Gone since it was read. Recreating it is not an overwrite of
        // somebody's work, so this is not the case to refuse.
        return false;
    };
    hash(&bytes) != *seen
}

/// Serialises the tests below. The registry is process-wide by design, and
/// `tracking_is_bounded_and_forgetting_permits_rather_than_refuses` fills it
/// past `MAX_TRACKED` on purpose — which, running in parallel, evicted entries
/// belonging to whichever test happened to be running beside it. The symptom
/// was a file that had just been remembered reporting as never seen.
#[cfg(test)]
fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Forget everything, then hold the suite lock for the caller's test.
#[cfg(test)]
fn isolated() -> std::sync::MutexGuard<'static, ()> {
    let guard = test_lock();
    if let Ok(mut registry) = registry().lock() {
        registry.0.clear();
    }
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, content: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        std::fs::write(&path, content).unwrap();
        (dir, path)
    }

    #[test]
    fn a_file_never_seen_is_not_stale() {
        let _serial = isolated();
        let (_dir, path) = temp_file("fresh.js", "const a = 1;\n");
        // Creating or overwriting a file nobody read is ordinary work.
        assert!(!changed_since_seen(&path));
    }

    #[test]
    fn an_unchanged_file_is_not_stale() {
        let _serial = isolated();
        let (_dir, path) = temp_file("steady.js", "const a = 1;\n");
        remember(&path);
        assert!(!changed_since_seen(&path));
    }

    #[test]
    fn a_file_changed_underneath_is_stale() {
        let _serial = isolated();
        let (_dir, path) = temp_file("moved.js", "const a = 1;\n");
        remember(&path);
        // The user's editor, a git pull, another agent — all this shape.
        std::fs::write(&path, "const a = 2;\n").unwrap();
        assert!(changed_since_seen(&path));
    }

    #[test]
    fn remembering_again_clears_the_staleness() {
        let _serial = isolated();
        let (_dir, path) = temp_file("rewritten.js", "const a = 1;\n");
        remember(&path);
        std::fs::write(&path, "const a = 2;\n").unwrap();
        assert!(changed_since_seen(&path));
        // An agent's own write must not make its next write stale.
        remember(&path);
        assert!(!changed_since_seen(&path));
    }

    #[test]
    fn a_deleted_file_is_not_reported_as_stale() {
        let _serial = isolated();
        let (_dir, path) = temp_file("gone.js", "const a = 1;\n");
        remember(&path);
        std::fs::remove_file(&path).unwrap();
        // Recreating it destroys nobody's work.
        assert!(!changed_since_seen(&path));
    }

    #[test]
    fn tracking_is_bounded_and_the_oldest_entry_is_the_one_dropped() {
        // Against a local map: filling the process-wide one to prove this
        // would evict entries other tests are relying on.
        let mut map: Registry = HashMap::new();
        for i in 0..(MAX_TRACKED + 1) {
            map.insert(PathBuf::from(format!("/tmp/file-{i}")), (0, i as u64));
            evict_oldest(&mut map);
        }
        assert_eq!(map.len(), MAX_TRACKED);
        assert!(
            !map.contains_key(&PathBuf::from("/tmp/file-0")),
            "the least recently recorded entry is the one that goes"
        );
        assert!(map.contains_key(&PathBuf::from(format!("/tmp/file-{MAX_TRACKED}"))));
    }

    #[test]
    fn forgetting_permits_rather_than_refuses() {
        let _serial = isolated();
        // A file the registry has forgotten reads as "never seen", which allows
        // the write. A bound that refused instead would block real work as the
        // registry filled.
        let (_dir, path) = temp_file("forgotten.js", "x");
        remember(&path);
        if let Ok(mut registry) = registry().lock() {
            registry.0.clear();
        }
        std::fs::write(&path, "changed").unwrap();
        assert!(!changed_since_seen(&path));
    }
}

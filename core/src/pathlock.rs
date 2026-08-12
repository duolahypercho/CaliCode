//! Per-path write serialization for the file tools.
//!
//! A turn's tool calls run concurrently (`agent.rs` joins them), so two
//! `file_edit` calls that a model emitted in the same turn — as it routinely
//! does when patching two spots in one file — used to interleave their
//! read-modify-write. Both read the same original text, both wrote their own
//! full copy, both reported `"written": true`, and whichever landed second
//! erased the other edit. The loss is silent: the model is told its edit
//! succeeded, so nothing in the transcript ever hints that a change is gone.
//!
//! The fix is the narrowest one that keeps the concurrency worth having: a
//! write to a path waits for any other write to THAT path, and nothing else
//! waits at all. Reads never take a lock, and writes to different files still
//! overlap.
//!
//! Entries are reclaimed as soon as nobody holds or wants them, so the
//! registry stays the size of the writes actually in flight rather than
//! growing one entry per file a long session ever touched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex as SyncMutex, Weak};
use tokio::sync::{Mutex, OwnedMutexGuard};

/// Live per-path locks, keyed by canonicalized path. `Weak` is what makes
/// reclamation safe: the map never keeps a lock alive on its own, so an entry
/// whose last waiter has gone is provably unused.
static REGISTRY: LazyLock<SyncMutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    LazyLock::new(|| SyncMutex::new(HashMap::new()));

/// Best-effort canonical key for a path that may not exist yet.
///
/// The resolvers hand back `root.join(rel)` without canonicalizing, so the
/// same file can arrive spelled several ways in one turn — `a.txt` and
/// `./a.txt`, a symlink and its target, an NFD path and the NFC repair of it.
/// Locking the literal spelling would leave those spellings racing each other,
/// which is exactly the bug. Canonicalize the leaf when it exists (a write to
/// an existing file, and every `file_edit`), otherwise canonicalize the parent
/// and re-attach the name, so a create and a later edit share one key.
fn lock_key(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(real) => real.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

/// Held for the whole read-modify-write of one path. Dropping it releases the
/// path and reclaims the registry entry if no one else is using it.
pub(crate) struct PathWriteGuard {
    key: PathBuf,
    /// `Option` only so `Drop` can release the path BEFORE reclaiming the
    /// entry — the reclamation test must not see this guard's own reference.
    guard: Option<OwnedMutexGuard<()>>,
}

impl Drop for PathWriteGuard {
    fn drop(&mut self) {
        drop(self.guard.take());
        let Ok(mut registry) = REGISTRY.lock() else {
            return; // Poisoned only if a holder panicked; leaking beats a double panic.
        };
        // Reclaim only when the last reference is gone. An acquirer upgrades
        // its `Weak` under this same lock, so there is no window where a live
        // lock reads as unused — a task that has upgraded already counts here,
        // and one that has not cannot have missed a removal it will redo.
        if let Some(slot) = registry.get(&self.key) {
            if slot.strong_count() == 0 {
                registry.remove(&self.key);
            }
        }
    }
}

/// Take the write lock for `path`, waiting for any write already in flight on
/// it. Callers must resolve the path first and hold the guard across the whole
/// read-modify-write — a lock taken after the read protects nothing.
pub(crate) async fn write_lock(path: &Path) -> PathWriteGuard {
    let key = lock_key(path);
    let lock = {
        let mut registry = REGISTRY.lock().expect("path lock registry poisoned");
        match registry.get(&key).and_then(Weak::upgrade) {
            Some(existing) => existing,
            None => {
                let fresh = Arc::new(Mutex::new(()));
                registry.insert(key.clone(), Arc::downgrade(&fresh));
                fresh
            }
        }
    };
    // Awaited with the registry released: a slow write must never block
    // writes to other paths from even looking up their lock.
    let guard = lock.lock_owned().await;
    PathWriteGuard {
        key,
        guard: Some(guard),
    }
}

/// Test-only: is a live entry registered for `path`? Asked per key rather
/// than by map size because the whole test binary shares one registry.
#[cfg(test)]
fn registry_holds(path: &Path) -> bool {
    REGISTRY.lock().unwrap().contains_key(&lock_key(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn same_path_writes_are_serialized() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared.txt");
        std::fs::write(&path, "0").unwrap();

        // `inside` is a deliberate non-atomic critical section: it can only
        // exceed 1 if two guards for the same path are live at once.
        let inside = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                let inside = inside.clone();
                let peak = peak.clone();
                tokio::spawn(async move {
                    let _guard = write_lock(&path).await;
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    inside.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1, "writes overlapped");
    }

    #[tokio::test]
    async fn different_paths_do_not_block_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a.txt");
        let second = dir.path().join("b.txt");
        let held = write_lock(&first).await;
        // Would hang if the lock were global rather than per path.
        let other = tokio::time::timeout(std::time::Duration::from_secs(5), write_lock(&second))
            .await
            .expect("a write to another path waited on an unrelated lock");
        drop(other);
        drop(held);
    }

    #[tokio::test]
    async fn spellings_of_one_file_share_a_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("same.txt");
        std::fs::write(&path, "x").unwrap();
        let dotted = dir.path().join(".").join("same.txt");
        let held = write_lock(&path).await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), write_lock(&dotted))
                .await
                .is_err(),
            "a second spelling of the same file took the lock concurrently"
        );
        drop(held);
    }

    #[tokio::test]
    async fn entries_are_reclaimed_when_unused() {
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one.txt");
        let two = dir.path().join("two.txt");
        {
            let _a = write_lock(&one).await;
            let _b = write_lock(&two).await;
            assert!(registry_holds(&one) && registry_holds(&two));
        }
        assert!(
            !registry_holds(&one) && !registry_holds(&two),
            "registry kept entries for paths nobody is writing"
        );
    }
}

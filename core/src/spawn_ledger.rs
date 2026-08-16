//! The record of which processes core itself started.
//!
//! Computer use may drive a window only when the process owning it is one core
//! spawned (`docs/plans/computer-use.md` §4.2). The whole safety story reduces
//! to one question — *did we start this pid?* — and the obvious answer, a set
//! of pids, is actively dangerous rather than merely incomplete.
//!
//! **Pids are recycled.** A headless Chrome exits and the kernel hands 4321 to
//! whatever launches next; a `/loop` runs for hours, which is long enough on a
//! busy machine for the counter to wrap. A ledger holding the bare pid would
//! keep answering "yes, that is our browser" after the browser is gone, and
//! attach scoping would deliver the agent to the one class of process it exists
//! to keep away from. That is not a stale-cache annoyance, it is the invariant
//! inverting itself.
//!
//! So an entry is a pid *and* the kernel's start time for that pid, and every
//! lookup re-reads the start time and compares. A recycled pid necessarily
//! started later than the one recorded, so it misses.
//!
//! The asymmetry that makes this safe is deliberate: a spawn site that forgets
//! to register costs a refused attach, which is visible and annoying. A stale
//! entry that matched would cost the invariant silently. Everything here fails
//! in the first direction — including platforms where the start time cannot be
//! read at all, where every lookup misses rather than degrading to pid-only.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// The one ledger for this process.
///
/// A global rather than a handle threaded through app state, because it models
/// a process-wide fact of the operating system — which pids *this* core
/// started — with no configuration and no possible second instance. The spawn
/// sites it must be reachable from live in five modules with five different
/// state shapes; threading a handle through all of them would be churn with no
/// second implementation to justify it.
pub fn global() -> &'static SpawnLedger {
    static LEDGER: OnceLock<SpawnLedger> = OnceLock::new();
    LEDGER.get_or_init(SpawnLedger::new)
}

/// What kind of process an entry describes. Carried so an approval card can
/// say *what* the agent is asking to drive, not just a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnKind {
    DevServer,
    Browser,
    Blender,
    Mcp,
}

impl SpawnKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SpawnKind::DevServer => "dev-server",
            SpawnKind::Browser => "browser",
            SpawnKind::Blender => "blender",
            SpawnKind::Mcp => "mcp",
        }
    }
}

/// One live process core started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub pid: u32,
    pub kind: SpawnKind,
    /// Human-readable, for approval cards and `computer_doctor` output.
    pub label: String,
    /// Kernel start time, in seconds since the epoch. The half of the identity
    /// that survives pid reuse.
    started: u64,
}

#[derive(Default)]
pub struct SpawnLedger {
    entries: Mutex<HashMap<u32, Entry>>,
}

impl SpawnLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a process core just spawned.
    ///
    /// Reads the start time *now*, as close to the spawn as the caller can
    /// manage. A process that has already exited by the time this runs cannot
    /// be identified and is not recorded — registering it would store a pid
    /// with no way to tell it from its successor.
    pub fn register(&self, pid: u32, kind: SpawnKind, label: impl Into<String>) {
        let Some(started) = start_time(pid) else {
            return;
        };
        let entry = Entry {
            pid,
            kind,
            label: label.into(),
            started,
        };
        self.entries.lock().unwrap().insert(pid, entry);
    }

    /// The entry for `pid`, if core started it *and* it is still that same
    /// process. Returns `None` for anything else, including a pid core once
    /// owned that the kernel has since handed to someone else.
    pub fn lookup(&self, pid: u32) -> Option<Entry> {
        let entry = self.entries.lock().unwrap().get(&pid).cloned()?;
        (start_time(pid)? == entry.started).then_some(entry)
    }

    /// Every entry still backed by the process it was recorded for. Reaps the
    /// ones that are not, so a long run does not accumulate the dead.
    pub fn list(&self) -> Vec<Entry> {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|pid, entry| start_time(*pid) == Some(entry.started));
        let mut live: Vec<Entry> = entries.values().cloned().collect();
        live.sort_by_key(|entry| entry.pid);
        live
    }
}

/// Kernel start time for `pid`, in whole seconds since the epoch.
///
/// `None` means "cannot tell", which callers must read as a miss rather than
/// as permission — see the module doc. Whole seconds is deliberately coarse:
/// it is compared against a value read from the same source, so the only
/// requirement is that a recycled pid differs, and a pid cannot be reissued
/// within the same second it was freed on any platform we run on.
#[cfg(target_os = "macos")]
fn start_time(pid: u32) -> Option<u64> {
    // SAFETY: `proc_pidinfo` writes at most `size` bytes into `info`, which is
    // a zeroed owned struct of exactly that size. A short or failed read is
    // reported by the return value and discarded below.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let read = libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        (read == size).then_some(info.pbi_start_tvsec)
    }
}

#[cfg(target_os = "linux")]
fn start_time(pid: u32) -> Option<u64> {
    // Field 22 of /proc/<pid>/stat is starttime in clock ticks since boot. The
    // comm field (2) can contain spaces and parens, so parsing starts after the
    // last ')' rather than splitting the whole line.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = &stat[stat.rfind(')')? + 1..];
    let ticks: u64 = after_comm.split_whitespace().nth(19)?.parse().ok()?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    (hz > 0).then(|| ticks / hz as u64)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn start_time(_pid: u32) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command};

    fn sleeper() -> Child {
        Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep must be spawnable")
    }

    #[test]
    fn a_registered_live_process_is_found() {
        let ledger = SpawnLedger::new();
        let mut child = sleeper();
        ledger.register(child.id(), SpawnKind::DevServer, "vite");

        let found = ledger
            .lookup(child.id())
            .expect("just-spawned pid must hit");
        assert_eq!(found.kind, SpawnKind::DevServer);
        assert_eq!(found.label, "vite");

        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn an_unregistered_process_misses() {
        let ledger = SpawnLedger::new();
        let mut child = sleeper();

        assert_eq!(
            ledger.lookup(child.id()),
            None,
            "a pid core never spawned must never resolve"
        );

        child.kill().ok();
        child.wait().ok();
    }

    /// The reason this module stores a start time at all. A recycled pid
    /// presents the same number with a different start time, and that is the
    /// case a pid-set ledger would wave through into whatever now owns it.
    #[test]
    fn a_recycled_pid_misses_even_though_the_number_matches() {
        let ledger = SpawnLedger::new();
        let mut child = sleeper();
        let pid = child.id();
        ledger.register(pid, SpawnKind::Browser, "chrome");
        assert!(ledger.lookup(pid).is_some());

        // Stand in for the kernel reissuing this pid to an unrelated process:
        // same number, earlier start. The live process no longer matches.
        {
            let mut entries = ledger.entries.lock().unwrap();
            entries.get_mut(&pid).unwrap().started -= 1;
        }

        assert_eq!(
            ledger.lookup(pid),
            None,
            "a pid whose start time moved is a different process and must miss"
        );

        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn a_dead_process_stops_resolving_and_is_reaped_from_the_listing() {
        let ledger = SpawnLedger::new();
        let mut child = sleeper();
        let pid = child.id();
        ledger.register(pid, SpawnKind::Blender, "blender");
        assert_eq!(ledger.list().len(), 1);

        child.kill().ok();
        child.wait().ok();

        assert_eq!(ledger.lookup(pid), None, "a reaped pid must not resolve");
        assert!(
            ledger.list().is_empty(),
            "listing must drop entries whose process is gone"
        );
    }

    /// Registration is best-effort, but it must never invent an identity it
    /// could not read — an entry with no verifiable start time is worse than
    /// no entry, because every later lookup would have nothing to compare.
    #[test]
    fn a_process_that_cannot_be_identified_is_not_recorded() {
        let ledger = SpawnLedger::new();
        // Pid 0 is never a process we spawned, and `proc_pidinfo` will not
        // describe it as one.
        ledger.register(0, SpawnKind::Mcp, "impossible");
        assert_eq!(ledger.lookup(0), None);
        assert!(ledger.list().is_empty());
    }
}

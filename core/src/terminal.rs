//! Shell work the *user* started: one-shot commands, and pty sessions.
//!
//! Two halves that answer different questions, and the difference is not
//! plumbing.
//!
//! `terminal_run` is a **one-shot runner**. No pty, so nothing that wants a
//! tty works: no `vim`, no pager, no password prompt, no job control, and no
//! input at all — stdin is `/dev/null`. A command starts, its stdout and
//! stderr stream out as they arrive, and it exits. It is confined to the
//! workspace root and capped at [`MAX_OUTPUT_BYTES`], which is what makes it a
//! good fit for scripted, fire-and-forget use.
//!
//! `terminal_open` is a **real terminal**: `$SHELL -i` on the far side of a
//! pty, alive until it is closed. That is the whole point — `cd`, exported
//! variables and shell history persist across commands, programs see a tty and
//! keep their colours, and interactive things (a REPL, `vim`, a `sudo` prompt)
//! work because keystrokes reach them.
//!
//! **A pty session is not confined by default, and pretending otherwise would
//! be a lie.** The one-shot runner is spawned under a Seatbelt profile that
//! makes the workspace root the only writable place and denies the network
//! (see `sandbox.rs`), which it can be because it never reads input. An
//! interactive shell is a different proposition: the user can type `cd /`, and
//! more to the point it is *their* shell on *their* machine. Confining it
//! silently would remove their network and their home directory with nothing
//! on screen to explain why. So the pty is confined only when
//! `sandbox.confine_terminal` is set, and that key defaults to false.
//!
//! What both halves *are* is **user-initiated**. Neither is an agent tool:
//! they skip the approval flow in `approvals.rs` and are absent from
//! `tools.rs`. Registering either would hand the model arbitrary code
//! execution on the user's machine — the exact thing
//! `devserver::resolve_command` goes out of its way to refuse — and for the
//! pty it would additionally hand it an unconfined one. Do not wire either
//! into a tool definition without solving that first.

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtyPair, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::broadcast::Sender;

use crate::sandbox;

/// Bytes streamed per run, counted across both pipes together. Past this the
/// run keeps going and its output keeps being drained, but nothing more is
/// published: an accidental `yes` or a chatty build would otherwise flood the
/// SSE bus and grow the client's log buffer without bound.
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

/// Output is read in chunks rather than by line. A line has no length limit,
/// so `lines()` would buffer an unbounded amount of a `yes`-style stream
/// before the cap above could see a single byte of it.
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// How long the pipes may stay open after the shell has been reaped. A
/// grandchild that outlived the group kill can hold them, and the exit event
/// must not wait on it forever.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Pty output is read in chunks this size. Small on purpose: a keystroke must
/// echo back before the reader blocks again, so this is a latency budget, not
/// a throughput one.
const PTY_READ_CHUNK_BYTES: usize = 4 * 1024;

/// Ceiling on how much the reader will coalesce into one event before
/// publishing regardless of how much more is waiting, so one burst cannot
/// starve the stream of everything behind it.
const PTY_COALESCE_BYTES: usize = 64 * 1024;

/// Bytes per write to the pty master, and the gap between them.
///
/// macOS sizes the tty input queue at `TTYHOG` — about 2 KB, an order of
/// magnitude smaller than Linux — and a single larger write containing
/// newlines arrives mangled or partly replayed. A pasted block is exactly that
/// write, so it is fed in small pieces with a pause between them, which is
/// what every terminal emulator that survives paste on macOS does.
const PTY_WRITE_CHUNK_BYTES: usize = 512;
const PTY_WRITE_GAP: Duration = Duration::from_millis(5);

/// Backlog on the SSE bus above which the reader stops to let it drain.
///
/// This is the backpressure valve, and it is deliberately aimed at the bus
/// rather than at the output rate. A `yes` loop in a pty produces output
/// forever and must keep rendering — capping it the way `terminal_run` does
/// would stop being a terminal — but the bus is a bounded broadcast, and a
/// receiver that falls behind is served `Lagged`, which `/events` handles by
/// skipping. Skipped bytes are a hole in the middle of the screen, not a
/// dropped tail. So the reader pauses while the queue is deep: that lets the
/// SSE stream catch up, and it lets the pty's own buffer fill, which blocks
/// the producing program at the source — exactly how a slow terminal emulator
/// slows `yes` down. When the client keeps up, the queue is empty and nothing
/// here costs anything.
const PTY_BUS_BACKLOG: usize = 64;

/// One pause; repeated while the backlog stays deep, up to [`PTY_MAX_PAUSE`].
const PTY_FLOOD_PAUSE: Duration = Duration::from_millis(5);

/// Ceiling on the pausing above. A receiver that never drains — a hung browser
/// tab still holding the SSE stream — must not stall the pty forever, and the
/// bus dropping events is a better outcome than a terminal that has frozen.
const PTY_MAX_PAUSE: Duration = Duration::from_millis(250);

/// How long a hung-up shell has to exit before it is killed outright.
///
/// SIGHUP first, because that is what closing a terminal window does and it
/// gives the shell the chance to hang up its own jobs — job control puts those
/// in process groups this code cannot enumerate, so the shell is the only
/// thing that can reach them. SIGKILL after, because "close" must actually
/// close.
const HANGUP_GRACE: Duration = Duration::from_millis(750);

/// Size a session falls back to. A pty with no size makes full-screen programs
/// draw into a 0x0 window.
pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;

/// Upper bound on a requested dimension. A client with a broken layout can ask
/// for something absurd, and the winsize ioctl takes it literally.
const MAX_DIMENSION: u16 = 1000;

type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// One live pty and the interactive shell inside it.
struct Session {
    cwd: PathBuf,
    shell: String,
    /// The shell's pid, which is also its process-group and session id:
    /// `portable-pty` calls `setsid` in the child before exec.
    pgid: i32,
    master: SharedMaster,
    writer: SharedWriter,
    /// Set once the shell has been reaped, so [`Terminals::close`]'s escalation
    /// timer knows not to signal a pid that may already have been recycled.
    reaped: Arc<AtomicBool>,
}

struct Run {
    command: String,
    cwd: PathBuf,
    /// Process-group id. Equal to the shell's pid because the shell is made
    /// its own group leader in [`shell_command`].
    pgid: i32,
}

/// Every command currently running and every open pty session. Both maps are
/// cloned into their supervisor, so an entry deletes itself the moment its
/// process exits; a map that only ever grew would leave `terminal_runs` and
/// `terminal_sessions` reporting processes that died hours ago.
#[derive(Clone, Default)]
pub struct Terminals {
    runs: Arc<Mutex<HashMap<String, Run>>>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

/// Tracks how much of a run's output has been published.
#[derive(Default)]
struct Budget {
    used: usize,
    capped: bool,
}

impl Terminals {
    /// Starts `command` under the user's shell, rooted at `root`.
    ///
    /// `cwd` is optional and must resolve inside `root`; see [`resolve_cwd`].
    pub fn start(
        &self,
        root: &Path,
        command: &str,
        cwd: Option<&str>,
        bus: Sender<Value>,
    ) -> Result<Value> {
        let command = command.trim();
        if command.is_empty() {
            anyhow::bail!("command cannot be empty");
        }
        let cwd = resolve_cwd(root, cwd)?;

        let mut child = tokio::process::Command::from(shell_command(
            std::env::var("SHELL").ok().as_deref(),
            command,
            root,
            &cwd,
        ))
        .spawn()
        .with_context(|| format!("failed to run {command:?} in {}", cwd.display()))?;
        let pgid = child
            .id()
            .context("the shell exited before it could be tracked")? as i32;

        let run_id = format!("term-{}", uuid::Uuid::new_v4());
        // Registered before the pipes are drained so a kill arriving in the
        // same millisecond as the start still finds something to signal.
        if let Ok(mut runs) = self.runs.lock() {
            runs.insert(
                run_id.clone(),
                Run {
                    command: command.to_string(),
                    cwd: cwd.clone(),
                    pgid,
                },
            );
        }

        let budget = Arc::new(Mutex::new(Budget::default()));
        let stdout = child.stdout.take().map(|pipe| {
            drain(
                pipe,
                "stdout",
                run_id.clone(),
                Arc::clone(&budget),
                bus.clone(),
            )
        });
        let stderr = child.stderr.take().map(|pipe| {
            drain(
                pipe,
                "stderr",
                run_id.clone(),
                Arc::clone(&budget),
                bus.clone(),
            )
        });

        let runs = Arc::clone(&self.runs);
        let id = run_id.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            let aborts: Vec<_> = [&stdout, &stderr]
                .into_iter()
                .flatten()
                .map(|task| task.abort_handle())
                .collect();
            // Every output event must precede the exit event, so the drains are
            // joined first — but only up to DRAIN_GRACE, because a surviving
            // grandchild holding the pipes would otherwise strand the run in the
            // UI as forever-running.
            let joined = tokio::time::timeout(DRAIN_GRACE, async {
                for task in [stdout, stderr].into_iter().flatten() {
                    let _ = task.await;
                }
            })
            .await;
            if joined.is_err() {
                for abort in aborts {
                    abort.abort();
                }
            }

            if let Ok(mut runs) = runs.lock() {
                runs.remove(&id);
            }
            let (code, signal) = match status {
                Ok(status) => (
                    status.code().map(Value::from).unwrap_or(Value::Null),
                    exit_signal(&status),
                ),
                Err(_) => (Value::Null, Value::Null),
            };
            let _ = bus.send(json!({
                "type": "terminal.exit", "runId": id, "code": code, "signal": signal,
            }));
        });

        Ok(json!({ "runId": run_id, "cwd": cwd.to_string_lossy() }))
    }

    /// Stops a run. Idempotent: a run that already exited reports
    /// `killed: false` rather than failing, because the UI's stop button races
    /// the command's own exit and neither outcome is an error.
    pub fn kill(&self, run_id: &str) -> Value {
        let killed = self
            .runs
            .lock()
            .ok()
            // The signal is sent while the map is held, and the supervisor
            // removes the entry only after reaping. Together that means a pgid
            // read here still belongs to this run and cannot have been recycled
            // onto somebody else's processes.
            .map(|runs| match runs.get(run_id) {
                Some(run) => {
                    kill_group(run.pgid, libc::SIGKILL);
                    true
                }
                None => false,
            })
            .unwrap_or(false);
        json!({ "runId": run_id, "killed": killed })
    }

    pub fn list(&self) -> Value {
        let mut runs: Vec<Value> = self
            .runs
            .lock()
            .map(|runs| {
                runs.iter()
                    .map(|(id, run)| {
                        json!({
                            "runId": id,
                            "command": run.command,
                            "cwd": run.cwd.to_string_lossy(),
                            "pid": run.pgid,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        runs.sort_by(|a, b| a["runId"].as_str().cmp(&b["runId"].as_str()));
        json!({ "runs": runs })
    }

    /// Starts an interactive shell in a pty, rooted at `root`.
    ///
    /// The shell is long-lived and is given no command: it is the session, and
    /// everything the user types goes to it through [`Terminals::input`].
    pub async fn open(
        &self,
        root: &Path,
        cols: u16,
        rows: u16,
        bus: Sender<Value>,
    ) -> Result<Value> {
        let shell = std::env::var("SHELL").ok();
        self.open_with(root, shell.as_deref(), cols, rows, bus)
            .await
    }

    /// [`Terminals::open`] with the shell chosen explicitly, so tests can pin
    /// one instead of inheriting whatever `$SHELL` the developer runs.
    async fn open_with(
        &self,
        root: &Path,
        shell: Option<&str>,
        cols: u16,
        rows: u16,
        bus: Sender<Value>,
    ) -> Result<Value> {
        // The session *starts* here; it is not held here. See the module
        // comment — an interactive shell can `cd` wherever the user can.
        let requested = resolve_cwd(root, None)?;
        let (cwd, refused) = start_dir(requested).await;
        let shell = interactive_shell(shell);

        let PtyPair { slave, master } = native_pty_system()
            .openpty(pty_size(cols, rows))
            .context("could not allocate a pty")?;
        let child = slave
            .spawn_command(pty_command(&shell, root, &cwd))
            .with_context(|| format!("failed to start {shell} in {}", cwd.display()))?;
        // The master only reports EOF once every slave fd is closed, and this
        // process holds one until it is dropped. Keeping it would mean the
        // reader never finishes and the session never reported itself closed.
        drop(slave);

        let pgid = child
            .process_id()
            .context("the shell exited before it could be tracked")? as i32;
        // The one and only consumer of the pty. `Waiting` duplicates the
        // descriptor but never reads it, so bytes are never split between two
        // readers — which would show up as output that arrives half-missing.
        let reader = master.try_clone_reader()?;
        let waiting = Waiting::clone_from(master.as_ref());
        let writer = master.take_writer()?;

        let session_id = format!("pty-{}", uuid::Uuid::new_v4());
        let reaped = Arc::new(AtomicBool::new(false));
        // Not held on the session: retiring is the reaper's call to make, after
        // the shell is gone and its last output has been drained.
        let retired = Arc::new(AtomicBool::new(false));
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(
                session_id.clone(),
                Session {
                    cwd: cwd.clone(),
                    shell: shell.clone(),
                    pgid,
                    master: Arc::new(Mutex::new(master)),
                    writer: Arc::new(Mutex::new(writer)),
                    reaped: Arc::clone(&reaped),
                },
            );
        }

        // Blocking threads rather than tokio tasks: a pty read cannot be
        // cancelled, so a task parked on one would pin a runtime worker until
        // the shell decided to say something.
        let (done, drained) = std::sync::mpsc::channel::<()>();
        spawn_pty_reader(
            reader,
            waiting,
            session_id.clone(),
            bus.clone(),
            Arc::clone(&retired),
            done,
        );
        spawn_pty_reaper(
            child,
            session_id.clone(),
            Arc::clone(&self.sessions),
            bus,
            reaped,
            retired,
            drained,
        );

        let mut opened = json!({
            "sessionId": session_id,
            "cwd": cwd.to_string_lossy(),
            "shell": shell,
        });
        // Present only when the workspace could not be used, so the UI can say
        // which folder was refused instead of leaving the user to wonder why
        // their terminal opened somewhere else.
        if let Some(refused) = refused {
            opened["cwdFallbackFrom"] = json!(refused.to_string_lossy());
        }
        Ok(opened)
    }

    /// Writes keystrokes to the pty master, byte for byte.
    ///
    /// Nothing is trimmed, normalised or interpreted: `data` carries control
    /// characters (Ctrl-C as `\u{3}`, arrows as escape sequences), and the
    /// line discipline on the far side is what gives them meaning.
    pub async fn input(&self, session_id: &str, data: &str) -> Result<Value> {
        let writer = self
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).map(|s| Arc::clone(&s.writer)))
            .with_context(|| format!("no terminal session {session_id}"))?;

        let bytes = data.as_bytes().to_vec();
        // Off the runtime: the tty input queue is small, so anything bigger
        // than a keystroke blocks until the far side reads it — and this feeds
        // it in pieces, which means sleeping between them.
        let written = tokio::task::spawn_blocking(move || -> Result<usize> {
            let mut writer = writer
                .lock()
                .map_err(|_| anyhow::anyhow!("terminal session is poisoned"))?;
            for (index, chunk) in bytes.chunks(PTY_WRITE_CHUNK_BYTES).enumerate() {
                if index > 0 {
                    std::thread::sleep(PTY_WRITE_GAP);
                }
                writer.write_all(chunk)?;
                writer.flush()?;
            }
            Ok(bytes.len())
        })
        .await??;
        Ok(json!({ "written": written }))
    }

    /// Tells the kernel the window changed size, which is what makes
    /// full-screen programs redraw. A session that has already gone reports
    /// `ok: false` rather than failing: a resize races a close, and losing
    /// that race is not an error.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<Value> {
        let Some(master) = self
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).map(|s| Arc::clone(&s.master)))
        else {
            return Ok(json!({ "ok": false }));
        };
        master
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal session is poisoned"))?
            .resize(pty_size(cols, rows))?;
        Ok(json!({ "ok": true }))
    }

    /// Ends a session. Idempotent for the same reason `kill` is: the close
    /// button races the shell's own `exit`, and neither outcome is an error.
    ///
    /// The `terminal.closed` event and the map removal are *not* done here —
    /// they belong to the reaper, so that a shell that exits on its own and a
    /// shell that is closed from the UI leave through exactly one door.
    pub fn close(&self, session_id: &str) -> Value {
        let Some(session) = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id))
        else {
            return json!({ "sessionId": session_id, "closed": false });
        };
        let pgid = session.pgid;
        let reaped = Arc::clone(&session.reaped);
        // Whatever the user was running when they hit close. Job control puts
        // a foreground command in its own process group, so hanging up the
        // shell alone would leave a `yes` or an `npm run dev` orphaned on a pty
        // nobody is watching. The kernel knows which group that is.
        let foreground = session
            .master
            .lock()
            .ok()
            .and_then(|master| master.process_group_leader())
            .filter(|group| *group != pgid);
        // Drops this process's master and writer fds. Not enough on its own to
        // hang the pty up — the reader thread holds a dup of the master — but
        // it does stop input from being accepted for a shell on its way out.
        drop(session);

        kill_group(pgid, libc::SIGHUP);
        if let Some(group) = foreground {
            kill_group(group, libc::SIGHUP);
        }
        std::thread::spawn(move || {
            std::thread::sleep(HANGUP_GRACE);
            if !reaped.load(Ordering::SeqCst) {
                kill_group(pgid, libc::SIGKILL);
                if let Some(group) = foreground {
                    kill_group(group, libc::SIGKILL);
                }
            }
        });
        json!({ "sessionId": session_id, "closed": true })
    }

    pub fn sessions(&self) -> Value {
        let mut sessions: Vec<Value> = self
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .map(|(id, session)| {
                        // Read back from the kernel rather than from a
                        // remembered number, so a resize that never reached the
                        // ioctl cannot be reported as if it had.
                        let size = session
                            .master
                            .lock()
                            .ok()
                            .and_then(|master| master.get_size().ok())
                            .unwrap_or_else(|| pty_size(DEFAULT_COLS, DEFAULT_ROWS));
                        json!({
                            "sessionId": id,
                            "cwd": session.cwd.to_string_lossy(),
                            "shell": session.shell,
                            "cols": size.cols,
                            "rows": size.rows,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        sessions.sort_by(|a, b| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()));
        json!({ "sessions": sessions })
    }

    /// Signals every live run and pty session. Called on shutdown: these
    /// children are in their own process groups and so are not covered by
    /// `kill_on_drop`, which is what keeps dev servers from being left behind.
    pub fn kill_all(&self) {
        if let Ok(runs) = self.runs.lock() {
            for run in runs.values() {
                kill_group(run.pgid, libc::SIGKILL);
            }
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            // SIGHUP then SIGKILL with no grace between them: the process is
            // going away now, so there is nobody left to run the escalation
            // timer `close` relies on. A shell that handles SIGHUP will have
            // hung up its jobs; one that does not is killed regardless.
            for session in sessions.values() {
                kill_group(session.pgid, libc::SIGHUP);
                kill_group(session.pgid, libc::SIGKILL);
            }
            sessions.clear();
        }
    }
}

/// Resolves the directory a command runs in, and confines it to `root`.
///
/// Absolute and relative inputs are both accepted, and both are canonicalized
/// before the containment check — the same reason `workspace::safe_resolve`
/// canonicalizes rather than trusting a lexical `..` scan: a symlink inside the
/// tree would otherwise walk straight out of it. A terminal that can `cd /` is
/// a different product.
pub fn resolve_cwd(root: &Path, cwd: Option<&str>) -> Result<PathBuf> {
    let root_real = root
        .canonicalize()
        .with_context(|| format!("{} is unavailable", root.display()))?;
    let Some(requested) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(root_real);
    };
    if requested.contains('\0') {
        anyhow::bail!("cwd is not a valid path");
    }

    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        root_real.join(requested)
    };
    let resolved = candidate
        .canonicalize()
        .with_context(|| format!("{requested} is not a readable directory"))?;
    if !resolved.is_dir() {
        anyhow::bail!("{requested} is not a directory");
    }
    if !resolved.starts_with(&root_real) {
        anyhow::bail!(
            "cwd {} is outside the workspace root {}",
            resolved.display(),
            root_real.display()
        );
    }
    Ok(resolved)
}

/// The shell invocation, before confinement.
///
/// The command line is handed to the shell verbatim and never parsed here:
/// splitting it would silently break quoting, globs, pipes and `&&`, and the
/// point of running through `$SHELL -lc` is that aliases, PATH and nvm-style
/// setups behave exactly as they do in Terminal.app. The `/bin/sh` fallback
/// gets `-c` alone, because `dash` — `/bin/sh` on Debian and Ubuntu — rejects
/// `-l` outright.
fn shell_argv(shell: Option<&str>, command: &str) -> (String, Vec<String>) {
    let (program, login) = match shell {
        Some(shell) if !shell.trim().is_empty() && Path::new(shell).exists() => (shell, true),
        _ => ("/bin/sh", false),
    };
    (
        program.to_string(),
        vec![
            if login { "-lc" } else { "-c" }.to_string(),
            command.to_string(),
        ],
    )
}

/// Builds the child process, confined to `root`.
fn shell_command(
    shell: Option<&str>,
    command: &str,
    root: &Path,
    cwd: &Path,
) -> std::process::Command {
    let (program, args) = shell_argv(shell, command);
    // A one-shot run reads no input, so unlike the pty it can be held to the
    // workspace: seatbelt makes that a kernel-enforced boundary rather than
    // the advisory one `resolve_cwd` gives. The *root* is what is writable,
    // not `cwd` — a run started in a subdirectory must still be able to touch
    // the rest of the project. Loopback only: a scripted build has no reason
    // to reach the internet.
    let policy = sandbox::workspace_policy(root, sandbox::Network::Loopback);
    let (program, args) = sandbox::confine(&policy, &program, &args);
    let mut process = std::process::Command::new(program);
    process.args(args);
    process.current_dir(cwd);

    // The environment is inherited so the command sees what the user's own
    // shell would — except for core's provider credentials, which nothing in a
    // workspace has any business reading back out.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("CALI_")
            && ["KEY", "TOKEN", "SECRET"]
                .iter()
                .any(|marker| name.contains(marker))
        {
            process.env_remove(&key);
        }
    }

    // No pty and no input: a command that blocks on stdin would otherwise hang
    // forever with nobody able to type at it.
    process.stdin(Stdio::null());
    process.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Its own process group, so `terminal_kill` reaches the whole tree. Killing
    // the shell alone leaves `npm test`'s node subprocesses running.
    std::os::unix::process::CommandExt::process_group(&mut process, 0);
    process
}

/// Answers "is there more output waiting right now?" for the reader.
///
/// It owns a duplicate of the master descriptor and **never reads from it** —
/// the pty has exactly one consumer, the cloned reader, and a second one would
/// split the stream between them. Owned rather than borrowed from the session
/// because a close drops the session's copy, and polling a descriptor the
/// kernel has since handed to another file is a bug that would be very hard to
/// find.
struct Waiting(std::os::unix::io::RawFd);

impl Waiting {
    fn clone_from(master: &dyn MasterPty) -> Option<Self> {
        // SAFETY: dup on a descriptor the master owns and keeps open until
        // after this call returns.
        let duplicate = unsafe { libc::dup(master.as_raw_fd()?) };
        (duplicate >= 0).then_some(Waiting(duplicate))
    }

    fn now(&self) -> bool {
        let mut poll = libc::pollfd {
            fd: self.0,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one descriptor this struct owns, and a zero timeout, so this
        // cannot block.
        unsafe { libc::poll(&mut poll, 1, 0) > 0 && poll.revents & libc::POLLIN != 0 }
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        // SAFETY: the descriptor was duplicated for this struct alone.
        unsafe {
            libc::close(self.0);
        }
    }
}

/// How long the start directory has to prove a shell can work in it.
const START_DIR_PROBE: Duration = Duration::from_millis(2000);

/// Chooses the directory the session actually starts in, returning the
/// workspace it refused when it had to move.
///
/// A directory that a shell cannot resolve is worse than useless as a starting
/// point: it produces a session that looks open and is dead. See
/// [`shell_can_work_in`] for why, and why the question cannot be answered by
/// core reading the folder itself.
async fn start_dir(requested: PathBuf) -> (PathBuf, Option<PathBuf>) {
    if probe(requested.clone()).await {
        return (requested, None);
    }
    tracing::warn!(
        directory = %requested.display(),
        "a shell cannot resolve this directory; starting the terminal session elsewhere"
    );
    // Home is not a protected location on macOS the way the folders inside it
    // are, but it is still somebody else's filesystem, so it is probed too.
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(home) = home.filter(|home| home.is_dir()) {
        if probe(home.clone()).await {
            return (home, Some(requested));
        }
    }
    (PathBuf::from("/"), Some(requested))
}

async fn probe(dir: PathBuf) -> bool {
    tokio::task::spawn_blocking(move || shell_can_work_in(&dir))
        .await
        .unwrap_or(false)
}

/// Confirms a shell started in `dir` will be able to name it.
///
/// **This cannot be answered from inside core.** On macOS a directory under
/// Desktop, Documents or Downloads that the calling process has no TCC grant
/// for does not fail — `open` blocks in the kernel, indefinitely — and the
/// grant belongs to the process making the call. Core is part of a signed app
/// bundle and may well hold that grant; `/bin/zsh` is a different binary and
/// need not, so core listing the folder happily proves nothing about the shell
/// it is about to spawn there. Replacing the app bundle invalidates the grant,
/// which is why this appears out of nowhere after a rebuild — the same hazard
/// `main.rs` already keeps off the startup path.
///
/// The failure it prevents is specific and was diagnosed from a live one: zsh
/// calls `getcwd` in `setupvals`, *before* it draws a prompt or initialises
/// the line editor. Blocked there, the shell never prompts, never takes the
/// tty out of canonical mode, and never reads a byte — so the pty dutifully
/// kernel-echoes everything typed at it and evaluates none of it. The session
/// looks alive from every angle except the only one that matters.
///
/// So the question is put the only way it can be answered: a throwaway child
/// doing exactly what the shell does, on a timer.
fn shell_can_work_in(dir: &Path) -> bool {
    // `pwd` is not busy-work — it is `getcwd`, the call that hangs.
    let spawned = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("pwd")
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut probe) = spawned else {
        return false;
    };

    let deadline = std::time::Instant::now() + START_DIR_PROBE;
    loop {
        match probe.try_wait() {
            Ok(Some(status)) => return status.success(),
            Err(_) => return false,
            Ok(None) => {}
        }
        if std::time::Instant::now() >= deadline {
            let _ = probe.kill();
            // Reaped elsewhere: a process wedged in the kernel may not die
            // promptly, and waiting on it here would hand this thread the very
            // hang the probe exists to avoid.
            std::thread::spawn(move || {
                let _ = probe.wait();
            });
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The shell a pty session runs.
///
/// `$SHELL` first, then the password database, then `/bin/sh`. The middle step
/// is not redundant: a core launched from the Finder inherits no `$SHELL` at
/// all, and dropping such a user into `/bin/sh` would give them a terminal
/// without their own configuration, aliases or history.
fn interactive_shell(shell: Option<&str>) -> String {
    if let Some(shell) = shell.map(str::trim).filter(|shell| usable_shell(shell)) {
        return shell.to_string();
    }
    // `CommandBuilder` does the passwd lookup already, and doing it here too
    // would mean a second unsafe `getpwuid` for no gain.
    let from_passwd = CommandBuilder::new_default_prog().get_shell();
    if usable_shell(&from_passwd) {
        return from_passwd;
    }
    "/bin/sh".to_string()
}

fn usable_shell(shell: &str) -> bool {
    !shell.is_empty() && Path::new(shell).is_file()
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(1, MAX_DIMENSION),
        cols: cols.clamp(1, MAX_DIMENSION),
        // Pixel dimensions are only used by programs drawing sixel graphics;
        // the client reports cells, and a wrong pixel size is worse than none.
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Builds the shell that becomes the session.
///
/// `-i` and no command: an interactive shell reads its rc files, keeps
/// history, enables job control, and — the entire reason this module grew a
/// pty — outlives each command the user runs, so `cd` and exports persist.
fn pty_command(shell: &str, root: &Path, cwd: &Path) -> CommandBuilder {
    // Off unless `sandbox.confine_terminal` is set. This is the user's own
    // shell: confining it silently would take away their network and their
    // home directory with no explanation and nothing on screen to blame, which
    // is a worse experience than the risk it removes. The one-shot runner —
    // which the model's scripted work actually goes through — is confined
    // unconditionally.
    let mut command = if sandbox::confine_terminal() {
        let policy = sandbox::workspace_policy(root, sandbox::Network::Loopback);
        let (program, args) = policy.wrap(shell, &["-i".to_string()]);
        let mut command = CommandBuilder::new(program);
        for arg in args {
            command.arg(arg);
        }
        command
    } else {
        let mut command = CommandBuilder::new(shell);
        command.arg("-i");
        command
    };
    command.cwd(cwd);

    // `TERM` decides what escape sequences programs are allowed to emit, and a
    // core launched from the macOS Finder inherits no `TERM` at all. It is set
    // rather than passed through because the far end is known: xterm.js.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // Same story for the locale, which a GUI launch also drops. Without it the
    // shell assumes C and mangles anything non-ASCII the user types.
    if std::env::var_os("LANG").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }

    // The environment is otherwise inherited so the shell behaves as the
    // user's own does — except for core's provider credentials, which nothing
    // the user runs has any business reading back out.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("CALI_")
            && ["KEY", "TOKEN", "SECRET"]
                .iter()
                .any(|marker| name.contains(marker))
        {
            command.env_remove(&key);
        }
    }
    command
}

/// Publishes the pty's byte stream onto the SSE bus.
///
/// The stream is passed through untouched — ANSI escapes, carriage returns and
/// all — because the client is a terminal emulator and stripping, colourising
/// or line-buffering any of it would be rewriting what the program drew.
fn spawn_pty_reader(
    mut reader: Box<dyn Read + Send>,
    waiting: Option<Waiting>,
    session_id: String,
    bus: Sender<Value>,
    retired: Arc<AtomicBool>,
    done: std::sync::mpsc::Sender<()>,
) {
    std::thread::spawn(move || {
        // Moved in so that this thread ending is what closes the channel; the
        // reaper waits on exactly that to order its event after the output.
        let _done = done;
        let mut buffer = vec![0u8; PTY_READ_CHUNK_BYTES];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                // The shell is gone. `portable-pty` already turns the EIO macOS
                // raises on hangup into a clean zero-length read.
                Ok(0) => break,
                Ok(read) => pending.extend_from_slice(&buffer[..read]),
                // A signal interrupted the read; the pty is fine. Treating this
                // as the end — as any catch-all `Err(_) => break` does — kills
                // the reader for the life of the session, and the terminal goes
                // silent while its shell carries on running.
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    if error.raw_os_error() != Some(libc::EIO) {
                        tracing::debug!(%error, session = %session_id, "pty read failed");
                    }
                    break;
                }
            }
            // The session may have been retired while this read was parked. It
            // is checked after the read rather than before because that is the
            // only moment this thread is awake, and leaving it running would
            // publish a dead session's output forever.
            if retired.load(Ordering::SeqCst) {
                break;
            }
            // More is already queued, so take that too and send one event
            // instead of several. This asks the kernel rather than waiting on a
            // timer: a timer long enough to coalesce a flood is also long
            // enough to strand the last line of a burst that just ended.
            if pending.len() < PTY_COALESCE_BYTES && waiting.as_ref().is_some_and(Waiting::now) {
                continue;
            }
            let text = take_utf8(&mut pending);
            if !text.is_empty() {
                let _ = bus.send(json!({
                    "type": "terminal.data", "sessionId": session_id, "data": text,
                }));
            }
            let mut waited = Duration::ZERO;
            while bus.len() > PTY_BUS_BACKLOG && waited < PTY_MAX_PAUSE {
                std::thread::sleep(PTY_FLOOD_PAUSE);
                waited += PTY_FLOOD_PAUSE;
            }
        }
        if !pending.is_empty() {
            let _ = bus.send(json!({
                "type": "terminal.data",
                "sessionId": session_id,
                "data": String::from_utf8_lossy(&pending),
            }));
        }
    });
}

/// Waits for the shell, then retires the session.
///
/// This is the only place a session leaves the map, whether it was closed from
/// the UI or the user typed `exit`. A session that outlived its shell would
/// keep accepting input for a pid that no longer exists.
fn spawn_pty_reaper(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    session_id: String,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    bus: Sender<Value>,
    reaped: Arc<AtomicBool>,
    retired: Arc<AtomicBool>,
    drained: std::sync::mpsc::Receiver<()>,
) {
    std::thread::spawn(move || {
        let status = child.wait();
        reaped.store(true, Ordering::SeqCst);

        // Every data event must precede the closed event, so the reader is
        // waited out first — but only up to DRAIN_GRACE, because a grandchild
        // that survived with the pty open would otherwise strand the session in
        // the UI as forever-live. `recv` returns the moment the reader thread
        // drops its sender, so the timeout is a backstop, not a delay.
        let _ = drained.recv_timeout(DRAIN_GRACE);
        // Retire before announcing: after this the reader publishes nothing
        // more, so `terminal.closed` really is the session's last event. It
        // also releases the reader's copy of the pty, and closing the last
        // master fd is what makes the kernel hang up anything still attached.
        retired.store(true, Ordering::SeqCst);

        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&session_id);
        }
        let code = status.map(|status| status.exit_code()).unwrap_or(1);
        let _ = bus.send(json!({
            "type": "terminal.closed", "sessionId": session_id, "code": code,
        }));
    });
}

/// Takes the complete UTF-8 prefix of `pending`, leaving any partial trailing
/// character behind.
///
/// A read can end mid-character, and publishing that tail would render as
/// U+FFFD in the client — permanently, because the next read carries the rest
/// of a character nobody is waiting for any more. Four or more unusable bytes
/// cannot be a split character, so that is genuinely invalid input and must
/// not be held back forever.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(error) => error.valid_up_to(),
    };
    if pending.len() - valid >= 4 {
        valid = pending.len();
    }
    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
    pending.drain(..valid);
    text
}

/// Streams one pipe onto the SSE bus, chunk by chunk.
fn drain<R>(
    mut reader: R,
    stream: &'static str,
    run_id: String,
    budget: Arc<Mutex<Budget>>,
    bus: Sender<Value>,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = vec![0u8; READ_CHUNK_BYTES];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let read = match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            pending.extend_from_slice(&buffer[..read]);
            let text = take_utf8(&mut pending);
            if !text.is_empty() {
                emit(&budget, &bus, &run_id, stream, &text);
            }
        }
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).into_owned();
            emit(&budget, &bus, &run_id, stream, &text);
        }
    })
}

fn emit(
    budget: &Mutex<Budget>,
    bus: &Sender<Value>,
    run_id: &str,
    stream: &'static str,
    text: &str,
) {
    let Ok(mut budget) = budget.lock() else {
        return;
    };
    if budget.capped {
        return;
    }
    let room = MAX_OUTPUT_BYTES.saturating_sub(budget.used);
    let notice = if text.len() <= room {
        budget.used += text.len();
        None
    } else {
        budget.used = MAX_OUTPUT_BYTES;
        budget.capped = true;
        Some(format!(
            "\n[calicode] output capped at {} MB; the command is still running, \
             but the rest of its output is discarded.\n",
            MAX_OUTPUT_BYTES / (1024 * 1024)
        ))
    };
    let chunk = &text[..floor_char_boundary(text, text.len().min(room))];
    if !chunk.is_empty() {
        publish(bus, run_id, stream, chunk);
    }
    if let Some(notice) = notice {
        publish(bus, run_id, stream, &notice);
    }
}

fn publish(bus: &Sender<Value>, run_id: &str, stream: &'static str, chunk: &str) {
    let _ = bus.send(json!({
        "type": "terminal.output", "runId": run_id, "stream": stream, "chunk": chunk,
    }));
}

/// Largest boundary at or below `index`, so a cut never lands mid-character.
fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn exit_signal(status: &std::process::ExitStatus) -> Value {
    std::os::unix::process::ExitStatusExt::signal(status)
        .map(Value::from)
        .unwrap_or(Value::Null)
}

/// Signals a whole process group.
///
/// One-shot runs get SIGKILL rather than SIGTERM: a graceful stage would need a
/// timer, and by the time it fired the group could have been reaped and its id
/// reused by an unrelated process. Stop means stop. Pty sessions are the
/// exception and hang up first — see [`HANGUP_GRACE`].
///
/// SAFETY: killpg only reads the two scalars passed to it.
fn kill_group(pgid: i32, signal: i32) {
    unsafe {
        libc::killpg(pgid, signal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collects every event for `run_id` until its exit event arrives.
    async fn collect(
        mut events: tokio::sync::broadcast::Receiver<Value>,
        run_id: &str,
    ) -> (String, String, Value) {
        let (mut stdout, mut stderr) = (String::new(), String::new());
        loop {
            let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
                .await
                .expect("timed out waiting for terminal events")
                .expect("event bus closed");
            if event["runId"] != json!(run_id) {
                continue;
            }
            match event["type"].as_str() {
                Some("terminal.output") => {
                    let chunk = event["chunk"].as_str().unwrap_or_default();
                    match event["stream"].as_str() {
                        Some("stdout") => stdout.push_str(chunk),
                        Some("stderr") => stderr.push_str(chunk),
                        other => panic!("unexpected stream {other:?}"),
                    }
                }
                Some("terminal.exit") => return (stdout, stderr, event),
                other => panic!("unexpected event {other:?}"),
            }
        }
    }

    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// Nothing in a pty test may wait on a prompt, a sleep, or a shell being
    /// "ready": it reads events until what it is looking for shows up, and
    /// gives up loudly if it never does. Generous, because it only ever
    /// elapses on a genuine hang.
    const PTY_TIMEOUT: Duration = Duration::from_secs(20);

    /// The shell pty tests run. Pinned rather than inherited so the suite does
    /// not depend on the developer's `$SHELL` or their rc files.
    const TEST_SHELL: &str = "/bin/sh";

    /// Accumulates `terminal.data` until `needle` appears in it.
    async fn expect_output(
        events: &mut tokio::sync::broadcast::Receiver<Value>,
        session_id: &str,
        needle: &str,
    ) -> String {
        let mut seen = String::new();
        loop {
            let event = tokio::time::timeout(PTY_TIMEOUT, events.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}; saw {seen:?}"))
                .expect("event bus closed");
            if event["sessionId"] != json!(session_id) {
                continue;
            }
            if event["type"] == json!("terminal.closed") {
                panic!("session closed before {needle:?} arrived; saw {seen:?}");
            }
            seen.push_str(event["data"].as_str().unwrap_or_default());
            if seen.contains(needle) {
                return seen;
            }
        }
    }

    async fn expect_closed(
        events: &mut tokio::sync::broadcast::Receiver<Value>,
        session_id: &str,
    ) -> Value {
        loop {
            let event = tokio::time::timeout(PTY_TIMEOUT, events.recv())
                .await
                .expect("timed out waiting for terminal.closed")
                .expect("event bus closed");
            if event["sessionId"] == json!(session_id) && event["type"] == json!("terminal.closed")
            {
                return event;
            }
        }
    }

    #[tokio::test]
    async fn a_pty_session_starts_a_shell_in_the_workspace_root() {
        let dir = root();
        let (bus, _events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();

        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();
        assert!(session_id.starts_with("pty-"), "sessionId was {session_id}");
        assert_eq!(
            opened["cwd"].as_str().unwrap(),
            dir.path().canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(opened["shell"], json!(TEST_SHELL));

        let listed = terminals.sessions();
        let session = &listed["sessions"][0];
        assert_eq!(session["sessionId"], json!(session_id));
        assert_eq!(session["cwd"], opened["cwd"]);
        assert_eq!(session["shell"], json!(TEST_SHELL));
        assert_eq!(session["cols"], json!(80));
        assert_eq!(session["rows"], json!(24));

        terminals.close(&session_id);
    }

    /// An unusable `$SHELL` must not stop a terminal from opening, and must not
    /// silently downgrade the user to `/bin/sh` while their real shell is
    /// sitting in the password database.
    #[test]
    fn an_unusable_session_shell_falls_back_to_a_real_one() {
        assert_eq!(interactive_shell(Some("/bin/sh")), "/bin/sh");
        for shell in [None, Some(""), Some("  "), Some("/nope/zsh")] {
            let resolved = interactive_shell(shell);
            assert!(
                Path::new(&resolved).is_file(),
                "{shell:?} resolved to {resolved}, which is not a shell"
            );
        }
    }

    /// The shell the user actually gets, as opposed to the `/bin/sh`
    /// portability floor the rest of these tests pin.
    fn real_interactive_shell() -> Option<&'static str> {
        ["/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash"]
            .into_iter()
            .find(|shell| Path::new(shell).is_file())
    }

    async fn expect_any_output(
        events: &mut tokio::sync::broadcast::Receiver<Value>,
        session_id: &str,
    ) -> String {
        loop {
            let event = tokio::time::timeout(PTY_TIMEOUT, events.recv())
                .await
                .expect("the shell produced no output at all")
                .expect("event bus closed");
            if event["sessionId"] != json!(session_id) {
                continue;
            }
            let data = event["data"].as_str().unwrap_or_default().to_string();
            if !data.is_empty() {
                return data;
            }
        }
    }

    /// The test that covers the shell people actually use.
    ///
    /// `/bin/sh` has no line editor: it never takes the tty out of canonical
    /// mode, so it exercises none of what zsh's ZLE or bash's readline do with
    /// a pty, and a session that works under it can still be dead under the
    /// real thing. Two claims are made here, and they are the two that matter:
    /// a prompt appears with nobody having typed anything, and what is typed
    /// afterwards actually runs.
    #[tokio::test]
    async fn a_real_interactive_shell_prompts_and_runs_what_it_is_sent() {
        // Skips rather than fails where neither shell is installed, so a
        // minimal CI container still passes.
        let Some(shell) = real_interactive_shell() else {
            return;
        };
        let dir = root();
        let marker = dir.path().join("typed-and-ran");
        let (bus, mut events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();

        let opened = terminals
            .open_with(dir.path(), Some(shell), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();
        assert_eq!(opened["shell"], json!(shell));

        // (a) The prompt. No input has been sent, so anything at all arriving
        // means the shell started, took the tty and drew itself.
        let prompt = expect_any_output(&mut events, &session_id).await;
        assert!(!prompt.is_empty(), "{shell} never drew a prompt");

        // (b) Evaluation, not echo. A dead shell still produces an echo — the
        // pty's line discipline does that on its own — so the assertion has to
        // be something only a running shell can say. `$((6*7))` comes back
        // literally in the echo and as `42` from the shell, and nothing else
        // can turn one into the other.
        terminals
            .input(&session_id, "echo MARK_$((6*7))_END\r")
            .await
            .unwrap();
        let seen = expect_output(&mut events, &session_id, "MARK_42_END").await;
        assert!(
            seen.contains("MARK_42_END"),
            "{shell} echoed but never evaluated: {seen:?}"
        );

        // And once more through the filesystem, which no amount of echo can
        // fake.
        terminals
            .input(&session_id, &format!("touch {}\r", marker.display()))
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + PTY_TIMEOUT;
        while !marker.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "{shell} never ran what it was sent"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        terminals.close(&session_id);
        expect_closed(&mut events, &session_id).await;
    }

    /// A start directory a shell cannot work in must not be handed to one.
    ///
    /// The real case is a macOS folder the shell has no TCC grant for, where
    /// `getcwd` blocks forever and the session comes up dead. That cannot be
    /// staged in a test, but the decision under test is the same one: the
    /// probe refuses the directory, the session opens somewhere usable, and it
    /// says which folder it could not use.
    #[tokio::test]
    async fn a_start_directory_the_shell_cannot_use_is_refused() {
        // SAFETY: geteuid only reads the calling process's own credentials.
        if unsafe { libc::geteuid() } == 0 {
            // root can enter anything, so the fixture below proves nothing.
            return;
        }
        let dir = root();
        let barred = dir.path().join("barred");
        std::fs::create_dir(&barred).unwrap();
        std::fs::set_permissions(&barred, std::os::unix::fs::PermissionsExt::from_mode(0o000))
            .unwrap();
        assert!(!shell_can_work_in(&barred));
        assert!(shell_can_work_in(dir.path()));

        let (bus, mut events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(&barred, Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();

        let refused = barred.canonicalize().unwrap();
        assert_eq!(
            opened["cwdFallbackFrom"].as_str().unwrap(),
            refused.to_string_lossy(),
            "the refused folder must be reported, not silently swapped"
        );
        assert_ne!(opened["cwd"].as_str().unwrap(), refused.to_string_lossy());

        // The point of moving is that the session works, so prove it the same
        // way: evaluation, not echo.
        terminals
            .input(&session_id, "echo MARK_$((6*7))_END\r")
            .await
            .unwrap();
        expect_output(&mut events, &session_id, "MARK_42_END").await;

        terminals.close(&session_id);
        std::fs::set_permissions(&barred, std::os::unix::fs::PermissionsExt::from_mode(0o700)).ok();
    }

    /// A paste is one `terminal_input` call far larger than the tty's input
    /// queue, and it has to arrive intact.
    #[tokio::test]
    async fn a_paste_larger_than_the_tty_queue_arrives_whole() {
        let dir = root();
        let (bus, mut events) = tokio::sync::broadcast::channel(1024);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();

        // Past macOS's ~2 KB TTYHOG, and deliberately under Linux's 4096-byte
        // canonical-mode line discipline buffer (`N_TTY_BUF_SIZE`), which
        // *discards* input past that on a line with no newline — so a 6000-byte
        // single line could never complete there and the shell never ran the
        // command. That is a kernel limit rather than anything this code can
        // chunk around, and it made the test fail deterministically on CI while
        // passing locally on macOS. 3000 still exceeds the queue this exercises
        // on both platforms.
        let filler = "x".repeat(3000);
        let written = terminals
            .input(&session_id, &format!("echo {filler} | wc -c\r"))
            .await
            .unwrap();
        assert_eq!(written["written"], json!(3014));

        // `wc -c` counts the echoed argument plus its newline: proof the whole
        // paste reached the shell rather than a truncated prefix.
        let seen = expect_output(&mut events, &session_id, "3001").await;
        assert!(seen.contains("3001"), "{seen:?}");

        terminals.close(&session_id);
    }

    /// Interactive and command-less: that pairing is what makes the session
    /// outlive each command, which is the entire reason the pty exists.
    #[test]
    fn the_session_shell_is_interactive_and_gets_no_command() {
        let dir = root();
        let command = pty_command("/bin/zsh", dir.path(), dir.path());
        let argv: Vec<String> = command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(argv, vec!["/bin/zsh", "-i"]);
        assert_eq!(command.get_cwd().unwrap(), dir.path().as_os_str());
        // xterm.js is the far end, so the shell is told exactly that.
        assert_eq!(command.get_env("TERM").unwrap(), "xterm-256color");
    }

    #[test]
    fn provider_credentials_are_scrubbed_from_the_session_shell() {
        let dir = root();
        std::env::set_var("CALI_ANTHROPIC_API_KEY", "sk-should-not-leak");
        std::env::set_var("CALI_PROJECTS_DIR_FOR_TEST", "/keep/me");
        let command = pty_command("/bin/sh", dir.path(), dir.path());
        let leaked = command.get_env("CALI_ANTHROPIC_API_KEY").is_some();
        let kept = command.get_env("CALI_PROJECTS_DIR_FOR_TEST").is_some();
        std::env::remove_var("CALI_ANTHROPIC_API_KEY");
        std::env::remove_var("CALI_PROJECTS_DIR_FOR_TEST");
        assert!(!leaked, "API keys must not reach an interactive shell");
        // Only credentials are removed; the rest of the environment is what
        // makes the shell behave like the user's own.
        assert!(kept, "non-secret CALI_ vars must still be inherited");
    }

    #[tokio::test]
    async fn typed_input_runs_in_the_session_shell() {
        let dir = root();
        let (bus, mut events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();

        // The quotes are load-bearing: the tty echoes the typed line back, so
        // `echo marker` would "pass" on the echo alone without the shell ever
        // running anything. Only execution can produce the unquoted spelling.
        let written = terminals
            .input(&session_id, "echo mar''ker-7\r")
            .await
            .unwrap();
        assert_eq!(written["written"], json!(16));

        expect_output(&mut events, &session_id, "marker-7").await;
        terminals.close(&session_id);
    }

    /// The test the one-shot runner could never pass: state set by one command
    /// is still there for the next one.
    #[tokio::test]
    async fn a_directory_change_persists_across_commands() {
        let dir = root();
        let (bus, mut events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();

        terminals.input(&session_id, "cd /tmp\r").await.unwrap();
        // The tty echoes both lines back, so the needle has to be something no
        // echo can produce: `$PWD` comes back unexpanded, and only the shell
        // actually standing in /tmp turns it into a path.
        terminals
            .input(&session_id, "pwd; echo \"at=$PWD\"\r")
            .await
            .unwrap();

        let seen = expect_output(&mut events, &session_id, "at=/").await;
        assert!(
            seen.contains("at=/tmp") || seen.contains("at=/private/tmp"),
            "the shell forgot its directory between commands: {seen:?}"
        );

        terminals.close(&session_id);
    }

    #[tokio::test]
    async fn resizing_updates_the_size_the_kernel_reports() {
        let dir = root();
        let (bus, _events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();

        assert_eq!(
            terminals.resize(&session_id, 120, 40).unwrap(),
            json!({ "ok": true })
        );
        let session = &terminals.sessions()["sessions"][0];
        assert_eq!(session["cols"], json!(120));
        assert_eq!(session["rows"], json!(40));

        // A resize that lands after the close button is a lost race, not a
        // failure the UI should surface.
        terminals.close(&session_id);
        assert_eq!(
            terminals.resize(&session_id, 90, 30).unwrap(),
            json!({ "ok": false })
        );
    }

    #[tokio::test]
    async fn closing_ends_the_shell_and_is_idempotent() {
        let dir = root();
        let (bus, mut events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();

        assert_eq!(terminals.close(&session_id)["closed"], json!(true));
        expect_closed(&mut events, &session_id).await;
        assert!(terminals.sessions()["sessions"]
            .as_array()
            .unwrap()
            .is_empty());

        // The close button races the shell's own exit, so a second close — and
        // a close of a session that never existed — reports false, not an error.
        assert_eq!(terminals.close(&session_id)["closed"], json!(false));
        assert_eq!(terminals.close("pty-nonexistent")["closed"], json!(false));
        assert!(terminals.input(&session_id, "ls\r").await.is_err());
    }

    /// Closing a terminal stops what the terminal was running, the way closing
    /// a Terminal.app window does. This asserts the outcome rather than the
    /// mechanism: a foreground command sits in its own process group, so
    /// whether it dies from the hangup this code sends, from the one the shell
    /// forwards, or from the pty being released, none of it may survive.
    #[tokio::test]
    async fn closing_a_session_stops_the_command_it_was_running() {
        let dir = root();
        let started = dir.path().join("running");
        let survived = dir.path().join("outlived-the-close");
        let (bus, mut events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();

        terminals
            .input(
                &session_id,
                &format!(
                    "touch {}; sleep 2; touch {}\r",
                    started.display(),
                    survived.display()
                ),
            )
            .await
            .unwrap();
        // The first file appearing is what proves the command is running, so
        // nothing here guesses at how long a shell takes to get going.
        let deadline = std::time::Instant::now() + PTY_TIMEOUT;
        while !started.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "the command never started"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        terminals.close(&session_id);
        expect_closed(&mut events, &session_id).await;
        // Long enough for the `sleep 2` to have finished had it survived.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(
            !survived.exists(),
            "the command outlived the terminal that was running it"
        );
    }

    #[tokio::test]
    async fn a_session_is_dropped_when_its_shell_exits_on_its_own() {
        let dir = root();
        let (bus, mut events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();
        assert_eq!(
            terminals.sessions()["sessions"].as_array().unwrap().len(),
            1
        );

        terminals.input(&session_id, "exit 7\r").await.unwrap();
        let closed = expect_closed(&mut events, &session_id).await;
        assert_eq!(closed["code"], json!(7));
        assert!(
            terminals.sessions()["sessions"]
                .as_array()
                .unwrap()
                .is_empty(),
            "a session whose shell exited must not linger in the map"
        );
    }

    #[tokio::test]
    async fn shutdown_stops_open_sessions() {
        let dir = root();
        let (bus, mut events) = tokio::sync::broadcast::channel(256);
        let terminals = Terminals::default();
        let opened = terminals
            .open_with(dir.path(), Some(TEST_SHELL), 80, 24, bus)
            .await
            .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();

        terminals.kill_all();
        expect_closed(&mut events, &session_id).await;
    }

    /// A read can split a multi-byte character; the tail waits for the rest
    /// rather than being published as U+FFFD.
    #[test]
    fn a_split_character_is_held_until_the_rest_of_it_arrives() {
        let mut pending = Vec::new();
        pending.extend_from_slice("ok ".as_bytes());
        pending.extend_from_slice(&"🎮".as_bytes()[..2]);
        assert_eq!(take_utf8(&mut pending), "ok ");
        assert_eq!(pending.len(), 2);

        pending.extend_from_slice(&"🎮".as_bytes()[2..]);
        assert_eq!(take_utf8(&mut pending), "🎮");
        assert!(pending.is_empty());

        // Bytes that cannot become a character are not held forever.
        let mut invalid = vec![0xff, 0xfe, 0xfd, 0xfc];
        assert!(!take_utf8(&mut invalid).is_empty());
        assert!(invalid.is_empty());
    }

    #[tokio::test]
    async fn a_run_streams_output_then_exits() {
        let dir = root();
        let (bus, events) = tokio::sync::broadcast::channel(64);
        let terminals = Terminals::default();

        let started = terminals
            .start(dir.path(), "echo hello-terminal", None, bus)
            .unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();
        assert!(run_id.starts_with("term-"), "runId was {run_id}");
        assert_eq!(
            started["cwd"].as_str().unwrap(),
            dir.path().canonicalize().unwrap().to_string_lossy()
        );

        let (stdout, _, exit) = collect(events, &run_id).await;
        assert_eq!(stdout, "hello-terminal\n");
        assert_eq!(exit["code"], json!(0));
        assert_eq!(exit["signal"], Value::Null);
    }

    #[tokio::test]
    async fn stderr_is_streamed_separately_from_stdout() {
        let dir = root();
        let (bus, events) = tokio::sync::broadcast::channel(64);
        let terminals = Terminals::default();

        let started = terminals
            .start(dir.path(), "echo out; echo err 1>&2", None, bus)
            .unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();

        let (stdout, stderr, exit) = collect(events, &run_id).await;
        assert_eq!(stdout, "out\n");
        assert_eq!(stderr, "err\n");
        assert_eq!(exit["code"], json!(0));
    }

    #[tokio::test]
    async fn a_non_zero_exit_is_reported_not_raised() {
        let dir = root();
        let (bus, events) = tokio::sync::broadcast::channel(64);
        let terminals = Terminals::default();

        // A failing test suite is an ordinary outcome for this RPC: the run
        // started fine, so `start` must succeed and the code arrives on the bus.
        let started = terminals.start(dir.path(), "exit 3", None, bus).unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();

        let (_, _, exit) = collect(events, &run_id).await;
        assert_eq!(exit["code"], json!(3));
        assert_eq!(exit["signal"], Value::Null);
    }

    #[tokio::test]
    async fn the_run_map_is_empty_once_a_command_exits() {
        let dir = root();
        let (bus, events) = tokio::sync::broadcast::channel(64);
        let terminals = Terminals::default();

        let started = terminals.start(dir.path(), "echo done", None, bus).unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();
        assert_eq!(terminals.list()["runs"].as_array().unwrap().len(), 1);

        collect(events, &run_id).await;
        assert!(
            terminals.list()["runs"].as_array().unwrap().is_empty(),
            "a finished run must not linger in the map"
        );
    }

    #[tokio::test]
    async fn kill_stops_a_long_command_and_is_idempotent() {
        let dir = root();
        let (bus, events) = tokio::sync::broadcast::channel(64);
        let terminals = Terminals::default();

        let started = terminals.start(dir.path(), "sleep 120", None, bus).unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();
        assert_eq!(terminals.kill(&run_id)["killed"], json!(true));

        let (_, _, exit) = collect(events, &run_id).await;
        assert_eq!(exit["code"], Value::Null);
        assert_eq!(exit["signal"], json!(libc::SIGKILL));

        // The stop button races the command's own exit, so a second kill — and
        // a kill of a run that finished on its own — reports false, not an error.
        assert_eq!(terminals.kill(&run_id)["killed"], json!(false));
        assert_eq!(terminals.kill("term-nonexistent")["killed"], json!(false));
    }

    #[tokio::test]
    async fn kill_stops_the_whole_process_group() {
        let dir = root();
        let marker = dir.path().join("grandchild-still-running");
        let (bus, events) = tokio::sync::broadcast::channel(64);
        let terminals = Terminals::default();

        // The shell backgrounds a subprocess and exits itself only when the
        // group dies; killing just the direct child would leave the sleep
        // running to write the marker.
        let command = format!(
            "(sleep 2; touch {}) & wait",
            marker.to_string_lossy().replace('\'', "")
        );
        let started = terminals.start(dir.path(), &command, None, bus).unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();

        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(terminals.kill(&run_id)["killed"], json!(true));
        collect(events, &run_id).await;

        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(
            !marker.exists(),
            "the backgrounded grandchild outlived the group kill"
        );
    }

    #[tokio::test]
    async fn output_is_capped_and_the_truncation_is_announced() {
        let dir = root();
        let (bus, events) = tokio::sync::broadcast::channel(4096);
        let terminals = Terminals::default();

        // Far more than the cap, from a command that never ends on its own.
        let started = terminals
            .start(dir.path(), "yes calicode-flood", None, bus)
            .unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();

        let mut events = events;
        let mut total = 0usize;
        let notice = loop {
            let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
                .await
                .expect("timed out waiting for the cap")
                .expect("event bus closed");
            if event["runId"] != json!(run_id) || event["type"] != json!("terminal.output") {
                continue;
            }
            let chunk = event["chunk"].as_str().unwrap().to_string();
            if chunk.contains("[calicode] output capped") {
                break chunk;
            }
            total += chunk.len();
        };
        assert!(notice.contains("2 MB"), "notice was {notice:?}");
        assert!(
            total <= MAX_OUTPUT_BYTES,
            "{total} bytes were published past the {MAX_OUTPUT_BYTES} byte cap"
        );

        terminals.kill(&run_id);
    }

    #[test]
    fn cwd_defaults_to_the_root() {
        let dir = root();
        assert_eq!(
            resolve_cwd(dir.path(), None).unwrap(),
            dir.path().canonicalize().unwrap()
        );
        assert_eq!(
            resolve_cwd(dir.path(), Some("  ")).unwrap(),
            dir.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn cwd_inside_the_root_is_accepted_absolute_or_relative() {
        let dir = root();
        let nested = dir.path().join("src/engine");
        std::fs::create_dir_all(&nested).unwrap();
        let real = nested.canonicalize().unwrap();

        assert_eq!(
            resolve_cwd(dir.path(), Some(real.to_str().unwrap())).unwrap(),
            real
        );
        assert_eq!(resolve_cwd(dir.path(), Some("src/engine")).unwrap(), real);
    }

    #[test]
    fn cwd_outside_the_root_is_rejected() {
        let dir = root();
        let outside = root();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();

        for escape in ["/", "/etc", "src/../..", ".."] {
            let error = resolve_cwd(dir.path(), Some(escape))
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("outside the workspace root"),
                "{escape} was not refused: {error}"
            );
        }
        assert!(resolve_cwd(dir.path(), Some(outside.path().to_str().unwrap())).is_err());
        // A path that does not exist cannot be confined either.
        assert!(resolve_cwd(dir.path(), Some("no/such/dir")).is_err());
    }

    #[test]
    fn a_symlink_out_of_the_root_is_rejected() {
        let dir = root();
        let outside = root();
        let link = dir.path().join("escape");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        // Lexically this is inside the root; only canonicalization catches it.
        let error = resolve_cwd(dir.path(), Some("escape"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("outside the workspace root"), "{error}");
    }

    #[test]
    fn a_file_is_not_a_working_directory() {
        let dir = root();
        std::fs::write(dir.path().join("main.js"), "// hi").unwrap();
        assert!(resolve_cwd(dir.path(), Some("main.js")).is_err());
    }

    #[test]
    fn the_command_line_is_handed_to_the_shell_verbatim() {
        let (program, args) = shell_argv(Some("/bin/bash"), "npm test -- --grep 'a b'");
        assert_eq!(program, "/bin/bash");
        // Login shell so aliases, PATH and nvm behave as they do in Terminal.app.
        assert_eq!(args, vec!["-lc", "npm test -- --grep 'a b'"]);
    }

    #[test]
    fn an_unusable_shell_falls_back_to_plain_sh() {
        for shell in [None, Some(""), Some("/nope/zsh")] {
            let (program, args) = shell_argv(shell, "echo hi");
            assert_eq!(program, "/bin/sh");
            // `-l` is not `-c`'s companion in dash, which is /bin/sh on Ubuntu.
            assert_eq!(args, vec!["-c", "echo hi"]);
        }
    }

    /// The one-shot runner is the path the model's scripted work takes, so it
    /// is confined unconditionally — unlike the pty below.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_one_shot_run_is_confined_to_the_workspace() {
        if !sandbox::settings().enabled {
            return;
        }
        let dir = root();
        let nested = dir.path().join("src");
        std::fs::create_dir_all(&nested).unwrap();
        let process = shell_command(Some("/bin/bash"), "echo hi", dir.path(), &nested);
        assert_eq!(process.get_program(), sandbox::SANDBOX_EXEC);
        let args: Vec<String> = process
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        // The workspace root is writable, not the subdirectory the run started
        // in — otherwise a run from `src/` could not touch the rest of it. The
        // canonical form is what seatbelt matches: a tempdir lives under
        // `/var/folders`, which is a symlink into `/private`.
        let root_real = dir.path().canonicalize().unwrap();
        assert!(args.iter().any(
            |arg| arg == &format!("WRITABLE_ROOT_1={}", root_real.display())
                || arg == &format!("WRITABLE_ROOT_0={}", root_real.display())
        ));
        assert!(args.iter().any(|arg| arg.starts_with("WRITABLE_ROOT_")
            && arg.ends_with(&format!("{}/.git", root_real.display()))));
        assert_eq!(process.get_current_dir(), Some(nested.as_path()));
    }

    /// The pty is the user's own shell; taking their network away without
    /// telling them would be a worse bug than the one it prevents.
    #[test]
    fn the_interactive_pty_is_unconfined_by_default() {
        let dir = root();
        let command = pty_command("/bin/sh", dir.path(), dir.path());
        assert_eq!(command.get_argv()[0], "/bin/sh");
        assert!(!sandbox::settings().confine_terminal);
    }

    #[test]
    fn provider_credentials_are_scrubbed_from_the_child() {
        let dir = root();
        std::env::set_var("CALI_OPENAI_API_KEY", "sk-should-not-leak");
        let process = shell_command(Some("/bin/bash"), "env", dir.path(), dir.path());
        let removed = process
            .get_envs()
            .any(|(key, value)| key == "CALI_OPENAI_API_KEY" && value.is_none());
        std::env::remove_var("CALI_OPENAI_API_KEY");
        assert!(removed, "API keys must not reach a spawned command");
    }

    #[tokio::test]
    async fn an_empty_command_is_refused() {
        let dir = root();
        let (bus, _events) = tokio::sync::broadcast::channel(4);
        let terminals = Terminals::default();
        assert!(terminals.start(dir.path(), "   ", None, bus).is_err());
    }

    #[tokio::test]
    async fn a_live_run_is_listed_with_its_command_and_cwd() {
        let dir = root();
        let nested = dir.path().join("game");
        std::fs::create_dir_all(&nested).unwrap();
        let (bus, events) = tokio::sync::broadcast::channel(64);
        let terminals = Terminals::default();

        let started = terminals
            .start(dir.path(), "sleep 120", Some("game"), bus)
            .unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();

        let listed = terminals.list();
        let run = &listed["runs"][0];
        assert_eq!(run["runId"], json!(run_id));
        assert_eq!(run["command"], json!("sleep 120"));
        assert_eq!(
            run["cwd"].as_str().unwrap(),
            nested.canonicalize().unwrap().to_string_lossy()
        );
        assert!(run["pid"].as_i64().unwrap() > 0);

        terminals.kill(&run_id);
        collect(events, &run_id).await;
    }
}

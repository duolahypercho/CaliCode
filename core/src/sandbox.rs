//! macOS Seatbelt confinement for the processes CaliCode spawns.
//!
//! A `/loop` runs unattended for hours against a repo the user did not write.
//! Nothing in the harness stopped a `postinstall` script, an MCP server or a
//! `npm run dev` from rewriting `~/`, deleting the git history, or POSTing the
//! working tree somewhere. Seatbelt is the only confinement macOS offers
//! without asking the user to install anything, so every spawn that can be
//! confined is rewritten into
//! `/usr/bin/sandbox-exec -p <profile> -D KEY=val … -- <command>`.
//!
//! **Seatbelt applies at exec and only at exec.** There is no way to retrofit
//! a profile onto a process that is already running, which is why this lives
//! at the spawn sites rather than behind some later checkpoint.
//!
//! Three things about the profile are load-bearing:
//!
//! 1. Writable roots are passed as `-D` parameters and referenced as
//!    `(param "WRITABLE_ROOT_0")`. Interpolating a path into the policy text
//!    would let a folder named `foo") (allow default) (deny nothing` rewrite
//!    the policy — the paths come from the user's filesystem, not from us.
//! 2. `.git` is read-only inside every writable root. An agent that trashes
//!    the working tree is an annoyance; one that also destroys the history is
//!    a catastrophe, and this single `require-not` is what keeps the first
//!    from becoming the second.
//! 3. Network is denied by *omission* — `network-outbound` is simply never
//!    allowed. The loopback carve-out exists because a dev server cannot bind
//!    a port at all without `system-socket` plus `network-bind`, so denying
//!    everything would have broken PLAY rather than protected it.
//!
//! What is deliberately **not** confined: the agent browser (`browser.rs`) and
//! Blender. Headless Chrome registers a crashpad handler over mach and holds
//! its ProcessSingleton on a unix socket outside any workspace; under Seatbelt
//! it does not start at all, and loosening the profile enough to let it start
//! would loosen it enough to be pointless. The interactive pty in
//! `terminal.rs` is off by default for a different reason — it is the user's
//! own shell, and silently taking away their network would be a surprise, not
//! a safeguard.
//!
//! Confinement is best-effort by design: if `sandbox-exec` is missing or the
//! platform is not macOS, spawns go out unwrapped. Failing them instead would
//! turn a hardening feature into an outage. [`status`] exists so the UI can
//! say which of the two actually happened.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Present on every macOS install since 10.5. Absence means something is very
/// wrong with the system, not that the user opted out — either way spawns
/// continue unwrapped.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Escape hatch for debugging a spawn that the profile broke. `0`, `off` and
/// `false` all disable confinement for the whole process.
pub const DISABLE_ENV: &str = "CALI_SANDBOX";

/// Never writable, in any writable root. `.git` is the whole point (see the
/// module comment); `.wt` holds worktree metadata that is just as unrecoverable.
const READ_ONLY_IN_ROOT: [&str; 2] = [".git", ".wt"];

/// `sandbox:` in `~/.cali/config.yaml`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SandboxConfig {
    /// Confine dev servers, MCP servers and one-shot terminal commands.
    pub enabled: bool,
    /// Let every confined process reach the network, not just loopback. MCP
    /// servers are exempt from the default deny regardless — see
    /// [`Network::Full`].
    pub allow_network: bool,
    /// Confine the *interactive* pty as well. Off by default: that shell is
    /// the user's own, and a terminal that silently cannot reach the network
    /// is a bug report waiting to happen.
    pub confine_terminal: bool,
    /// Extra writable roots, for the MCP server that keeps its state in
    /// `~/Documents/notes` and would otherwise force the sandbox off entirely.
    /// `~` is expanded.
    pub writable_extra: Vec<String>,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            allow_network: false,
            confine_terminal: false,
            writable_extra: Vec::new(),
        }
    }
}

/// What the configuration actually resolved to on this machine.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub allow_network: bool,
    pub confine_terminal: bool,
    pub extra_writable: Vec<PathBuf>,
    /// Why confinement is impossible here, if it is. Distinct from
    /// `enabled: false` by choice: "you turned it off" and "this OS cannot do
    /// it" must not look the same in the UI.
    pub unavailable: Option<&'static str>,
}

/// `None` when Seatbelt can be used here.
fn unavailable_reason(sandbox_exec_present: bool) -> Option<&'static str> {
    if !cfg!(target_os = "macos") {
        Some("process confinement is implemented for macOS only")
    } else if !sandbox_exec_present {
        Some("/usr/bin/sandbox-exec is missing")
    } else {
        None
    }
}

fn env_disabled() -> bool {
    match std::env::var(DISABLE_ENV) {
        Ok(value) => matches!(value.trim(), "0" | "off" | "false" | "no"),
        Err(_) => false,
    }
}

impl Settings {
    fn resolve(config: &SandboxConfig) -> Self {
        let unavailable = unavailable_reason(Path::new(SANDBOX_EXEC).exists());
        Self {
            enabled: config.enabled && !env_disabled() && unavailable.is_none(),
            allow_network: config.allow_network,
            confine_terminal: config.confine_terminal,
            extra_writable: config
                .writable_extra
                .iter()
                .map(|path| crate::config::expand_tilde(path))
                .collect(),
            unavailable,
        }
    }
}

static SETTINGS: OnceLock<Settings> = OnceLock::new();

/// Resolves the configuration once and says so in the log. Called from `main`
/// before anything can spawn; the warning belongs here rather than at the
/// spawn sites, which would repeat it for every dev server and MCP child.
pub fn init(config: &SandboxConfig) {
    let resolved = Settings::resolve(config);
    if let Some(reason) = resolved.unavailable {
        tracing::warn!(%reason, "spawning without confinement");
    } else if !resolved.enabled {
        tracing::warn!("process confinement is disabled; spawns are unconfined");
    } else {
        tracing::info!(
            allow_network = resolved.allow_network,
            confine_terminal = resolved.confine_terminal,
            "confining spawned processes with seatbelt"
        );
    }
    let _ = SETTINGS.set(resolved);
}

/// The effective settings. Falls back to the defaults when `init` has not run,
/// so a unit test that never boots `main` still sees a coherent answer.
pub fn settings() -> &'static Settings {
    SETTINGS.get_or_init(|| Settings::resolve(&SandboxConfig::default()))
}

/// Whether the interactive pty should be confined. Separate from
/// [`Settings::enabled`] because it defaults the other way.
pub fn confine_terminal() -> bool {
    let settings = settings();
    settings.enabled && settings.confine_terminal
}

/// Truthful confinement state for `/health`, so the UI never implies a
/// sandbox that is not there.
pub fn status() -> Value {
    let settings = settings();
    json!({
        "enabled": settings.enabled,
        "allowNetwork": settings.allow_network,
        "confineTerminal": settings.confine_terminal,
        "unavailable": settings.unavailable,
    })
}

/// How much of the network a confined process gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    /// Loopback only: enough to bind and serve a dev server, not enough to
    /// send the workspace anywhere.
    Loopback,
    /// Unrestricted. MCP servers get this: most of them exist precisely to
    /// call a remote API, and denying egress would not harden them, it would
    /// just stop them working.
    Full,
}

#[derive(Debug, Clone)]
struct WritableRoot {
    path: PathBuf,
    excluded: Vec<PathBuf>,
}

/// A filesystem and network shape, ready to be turned into an SBPL profile.
#[derive(Debug, Clone)]
pub struct Policy {
    roots: Vec<WritableRoot>,
    network: Network,
}

impl Policy {
    pub fn new(network: Network) -> Self {
        Self {
            roots: Vec::new(),
            network,
        }
    }

    /// Adds a writable root with no exclusions — caches and temp dirs, which
    /// have no history worth protecting.
    pub fn writable(mut self, path: impl AsRef<Path>) -> Self {
        self.push_root(path.as_ref(), &[]);
        self
    }

    /// Adds a project root: writable, except for the directories in
    /// [`READ_ONLY_IN_ROOT`].
    pub fn workspace(mut self, root: impl AsRef<Path>) -> Self {
        self.push_root(root.as_ref(), &READ_ONLY_IN_ROOT);
        self
    }

    /// Both the given path and its canonical form are added when they differ.
    /// Seatbelt matches resolved paths, and on macOS `/tmp` is a symlink to
    /// `/private/tmp` and `$TMPDIR` lives under `/private/var/folders` — a
    /// policy naming only the symlink permits nothing at all.
    fn push_root(&mut self, path: &Path, excluded: &[&str]) {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        for candidate in [path.to_path_buf(), canonical] {
            if !candidate.is_absolute() || self.roots.iter().any(|root| root.path == candidate) {
                continue;
            }
            let excluded = excluded.iter().map(|name| candidate.join(name)).collect();
            self.roots.push(WritableRoot {
                path: candidate,
                excluded,
            });
        }
    }

    /// `-D` arguments, in the order the profile's parameter names expect.
    pub fn params(&self) -> Vec<String> {
        let mut params = Vec::new();
        for (index, root) in self.roots.iter().enumerate() {
            params.push(format!(
                "{}={}",
                root_param(index),
                root.path.to_string_lossy()
            ));
            for (excluded_index, excluded) in root.excluded.iter().enumerate() {
                params.push(format!(
                    "{}={}",
                    excluded_param(index, excluded_index),
                    excluded.to_string_lossy()
                ));
            }
        }
        params
    }

    /// The SBPL profile. Contains no path text at all: every filesystem
    /// location is a `(param …)` reference resolved by `sandbox-exec` from the
    /// `-D` arguments, so a path holding a quote or a paren cannot reshape it.
    pub fn profile(&self) -> String {
        let mut profile = String::from(PREAMBLE);
        profile.push_str(match self.network {
            Network::Loopback => LOOPBACK_NETWORK,
            Network::Full => FULL_NETWORK,
        });
        for (index, root) in self.roots.iter().enumerate() {
            profile.push_str("\n(allow file-write*\n  (require-all\n    (subpath (param \"");
            profile.push_str(&root_param(index));
            profile.push_str("\"))");
            for excluded_index in 0..root.excluded.len() {
                profile.push_str("\n    (require-not (subpath (param \"");
                profile.push_str(&excluded_param(index, excluded_index));
                profile.push_str("\")))");
            }
            profile.push_str("))\n");
        }
        // The `require-not` above is necessary but not sufficient: writable
        // roots can nest, and a workspace checked out under `/tmp` — or under
        // `$TMPDIR`, which is where every test puts one — is covered by a
        // second, unrestricted `allow` that grants what the first withheld.
        // Seatbelt takes the *last* matching rule, so the exclusions are
        // restated as trailing denies where nothing can shadow them.
        let denies: Vec<String> = self
            .roots
            .iter()
            .enumerate()
            .flat_map(|(index, root)| {
                (0..root.excluded.len()).map(move |excluded| excluded_param(index, excluded))
            })
            .collect();
        if !denies.is_empty() {
            profile.push('\n');
            for param in denies {
                profile.push_str(&format!(
                    "(deny file-write* (subpath (param \"{param}\")))\n"
                ));
            }
        }
        profile
    }

    /// Rewrites a spawn into a `sandbox-exec` invocation, unconditionally.
    /// Callers that should honour the configuration go through [`confine`].
    pub fn wrap(&self, program: &str, args: &[String]) -> (String, Vec<String>) {
        let mut wrapped = vec!["-p".to_string(), self.profile()];
        for param in self.params() {
            wrapped.push("-D".to_string());
            wrapped.push(param);
        }
        // Without `--`, a command whose first argument starts with `-` is
        // eaten by sandbox-exec's own option parsing.
        wrapped.push("--".to_string());
        wrapped.push(program.to_string());
        wrapped.extend(args.iter().cloned());
        (SANDBOX_EXEC.to_string(), wrapped)
    }
}

fn root_param(index: usize) -> String {
    format!("WRITABLE_ROOT_{index}")
}

fn excluded_param(index: usize, excluded_index: usize) -> String {
    format!("WRITABLE_ROOT_{index}_EXCLUDED_{excluded_index}")
}

/// The writable set every confined spawn needs regardless of what it is.
///
/// `$TMPDIR` and `/tmp` are not a convenience: `git` shells out to `xcrun`,
/// which fails loudly when it cannot write its cache, and `~/.npm` is where
/// npm insists on writing `_logs/*.log` before it will run anything at all.
fn caches(mut policy: Policy) -> Policy {
    if let Some(tmpdir) = std::env::var_os("TMPDIR") {
        policy = policy.writable(PathBuf::from(tmpdir));
    }
    policy = policy.writable("/tmp");
    let home = crate::config::home_dir();
    policy = policy.writable(home.join(".npm"));
    policy.writable(home.join(".cache"))
}

/// A workspace-rooted policy: the project is writable except for its history,
/// plus the caches the toolchain cannot live without.
pub fn workspace_policy(root: &Path, network: Network) -> Policy {
    caches(Policy::new(network).workspace(root))
}

/// A policy for a process with no workspace of its own — an MCP server, which
/// is configured globally and started before any project is open. It gets the
/// caches and core's own state directory and nothing else, so a server that
/// persists elsewhere needs `sandbox.writable_extra`.
pub fn ambient_policy(network: Network) -> Policy {
    caches(Policy::new(network).writable(crate::config::home_dir().join(".cali")))
}

/// Rewrites a spawn into a confined one, honouring the configuration.
///
/// Returns `(program, args)` untouched when confinement is off or impossible.
/// A spawn is never failed for want of a sandbox — that would turn hardening
/// into downtime — which is why [`status`] reports the real state instead.
pub fn confine(policy: &Policy, program: &str, args: &[String]) -> (String, Vec<String>) {
    confine_with(settings(), policy, program, args)
}

fn confine_with(
    settings: &Settings,
    policy: &Policy,
    program: &str,
    args: &[String],
) -> (String, Vec<String>) {
    if !settings.enabled {
        return (program.to_string(), args.to_vec());
    }
    let mut policy = policy.clone();
    if settings.allow_network {
        policy.network = Network::Full;
    }
    for extra in &settings.extra_writable {
        policy.push_root(extra, &READ_ONLY_IN_ROOT);
    }
    policy.wrap(program, args)
}

/// Everything a real toolchain turned out to need, and nothing more.
///
/// The `sysctl-read` allowlist is not padding: without `hw.ncpu` and friends
/// `os.cpus()` comes back empty and build tools that size their worker pool
/// from it either crash or fall back to one thread. `pseudo-tty` plus
/// `/dev/ptmx` and the `ttys` regex are what let a shell get a tty at all.
const PREAMBLE: &str = r##"(version 1)
(deny default)

; Reads are unrestricted on purpose. The threat being answered is destruction
; and exfiltration, and a read-tight profile breaks every toolchain that
; consults a config outside the project (nvm, rustup, pnpm's store, ...).
(allow file-read*)

; A confined process's children inherit the profile, so exec and fork are what
; make `npm run` work rather than a hole in the policy.
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cpusubtype")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  ; Not optional: libuv's uv_cpu_info bails out entirely when it cannot read
  ; the model string, and `os.cpus()` then reports zero cores — which build
  ; tools turn into a one-worker build or a divide-by-zero crash.
  (sysctl-name "hw.model")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name-prefix "hw.optional.")
  (sysctl-name-prefix "hw.perflevel"))

; Power-state queries; libuv asks on startup and treats a denial as fatal.
(allow iokit-open
  (iokit-user-client-class "RootDomainUserClient"))

; getpwuid and CFPreferences. A denial here shows up as a process that cannot
; work out its own home directory.
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon")
  ; `confstr(_CS_DARWIN_USER_TEMP_DIR)`. git asks on every invocation and
  ; prints a warning per call without it, and xcodebuild then fails to find
  ; its cache directory at all.
  (global-name "com.apple.bsd.dirhelper"))

(allow ipc-posix-sem)

; Without these a shell gets no controlling terminal, which breaks anything
; that asks whether it is interactive.
(allow pseudo-tty)
(allow file-write* (literal "/dev/ptmx"))
(allow file-write* (regex #"^/dev/ttys[0-9]+$"))
"##;

/// Loopback is carved out rather than denied wholesale because a dev server
/// cannot reach LISTENING without `system-socket` and `network-bind`, and PLAY
/// is the reason the dev server exists. Everything else stays denied by the
/// absence of an unqualified `network-outbound` rule — including the unix
/// socket to `mDNSResponder`, so name resolution cannot be used as a side
/// channel either.
const LOOPBACK_NETWORK: &str = r##"
(allow system-socket)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
"##;

const FULL_NETWORK: &str = r##"
(allow system-socket)
(allow network*)
"##;

#[cfg(test)]
mod tests {
    use super::*;

    fn disabled() -> Settings {
        Settings {
            enabled: false,
            allow_network: false,
            confine_terminal: false,
            extra_writable: Vec::new(),
            unavailable: None,
        }
    }

    fn enabled() -> Settings {
        Settings {
            enabled: true,
            ..disabled()
        }
    }

    #[test]
    fn writable_roots_are_parameters_never_policy_text() {
        let policy = Policy::new(Network::Loopback).workspace("/Users/someone/game");
        let profile = policy.profile();
        assert!(profile.contains(r#"(subpath (param "WRITABLE_ROOT_0"))"#));
        // The whole point: no filesystem path ever reaches the policy source.
        assert!(!profile.contains("/Users/someone/game"));
        assert!(policy
            .params()
            .contains(&"WRITABLE_ROOT_0=/Users/someone/game".to_string()));
    }

    #[test]
    fn git_is_read_only_inside_every_writable_root() {
        let policy = Policy::new(Network::Loopback).workspace("/Users/someone/game");
        assert!(policy
            .profile()
            .contains(r#"(require-not (subpath (param "WRITABLE_ROOT_0_EXCLUDED_0")))"#));
        let params = policy.params();
        assert!(params.contains(&"WRITABLE_ROOT_0_EXCLUDED_0=/Users/someone/game/.git".to_string()));
        assert!(params.contains(&"WRITABLE_ROOT_0_EXCLUDED_1=/Users/someone/game/.wt".to_string()));
    }

    #[test]
    fn exclusions_are_restated_as_denies_a_nested_root_cannot_shadow() {
        // `workspace_policy` also makes `/tmp` writable, and a workspace under
        // it would otherwise inherit write access to its own history.
        let profile = workspace_policy(Path::new("/tmp/nested/game"), Network::Loopback).profile();
        let deny = r#"(deny file-write* (subpath (param "WRITABLE_ROOT_0_EXCLUDED_0")))"#;
        assert!(profile.contains(deny));
        // Order is the guarantee: seatbelt takes the last matching rule.
        assert!(profile.rfind(deny) > profile.rfind(r#"(subpath (param "WRITABLE_ROOT_1"))"#));
    }

    #[test]
    fn a_path_with_quotes_and_parens_cannot_reach_the_policy() {
        let hostile = r#"/tmp/a") (allow default) (deny (nothing"#;
        let policy = Policy::new(Network::Loopback).workspace(hostile);
        let profile = policy.profile();
        assert!(!profile.contains("allow default"));
        assert!(!profile.contains("deny (nothing"));
        assert!(policy.params().iter().any(|param| param.ends_with(hostile)));
    }

    #[test]
    fn loopback_policy_never_allows_general_egress() {
        let profile = Policy::new(Network::Loopback).profile();
        assert!(profile.contains(r#"(allow network-outbound (remote ip "localhost:*"))"#));
        assert!(!profile.contains("(allow network*)"));
        // A dev server that cannot open a socket at all never binds.
        assert!(profile.contains("(allow system-socket)"));
    }

    #[test]
    fn mcp_policy_keeps_egress() {
        assert!(ambient_policy(Network::Full)
            .profile()
            .contains("(allow network*)"));
    }

    #[test]
    fn disabled_settings_spawn_unwrapped() {
        let policy = Policy::new(Network::Loopback).workspace("/tmp/x");
        let (program, args) = confine_with(&disabled(), &policy, "/bin/sh", &["-c".into()]);
        assert_eq!(program, "/bin/sh");
        assert_eq!(args, vec!["-c".to_string()]);
    }

    #[test]
    fn enabled_settings_wrap_the_spawn() {
        let policy = Policy::new(Network::Loopback).workspace("/tmp/x");
        let (program, args) = confine_with(&enabled(), &policy, "/bin/echo", &["hi".into()]);
        assert_eq!(program, SANDBOX_EXEC);
        assert_eq!(args.first().map(String::as_str), Some("-p"));
        // `--` must precede the command or an argument starting with `-` is
        // parsed as one of sandbox-exec's own options.
        let separator = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[separator + 1], "/bin/echo");
        assert_eq!(args[separator + 2], "hi");
    }

    #[test]
    fn allow_network_promotes_a_loopback_policy() {
        let settings = Settings {
            allow_network: true,
            ..enabled()
        };
        let policy = Policy::new(Network::Loopback);
        let (_, args) = confine_with(&settings, &policy, "/bin/echo", &[]);
        assert!(args[1].contains("(allow network*)"));
    }

    #[test]
    fn extra_writable_roots_are_added_with_their_own_git_exclusion() {
        let settings = Settings {
            extra_writable: vec![PathBuf::from("/Users/someone/notes")],
            ..enabled()
        };
        let (_, args) = confine_with(&settings, &Policy::new(Network::Loopback), "/bin/echo", &[]);
        assert!(args
            .iter()
            .any(|arg| arg == "WRITABLE_ROOT_0=/Users/someone/notes"));
        assert!(args
            .iter()
            .any(|arg| arg == "WRITABLE_ROOT_0_EXCLUDED_0=/Users/someone/notes/.git"));
    }

    #[test]
    fn a_missing_sandbox_exec_degrades_to_unconfined() {
        let reason = unavailable_reason(false);
        assert!(reason.is_some());
        let settings = Settings {
            enabled: SandboxConfig::default().enabled && reason.is_none(),
            unavailable: reason,
            ..disabled()
        };
        assert!(!settings.enabled);
        let (program, _) = confine_with(&settings, &Policy::new(Network::Loopback), "/bin/sh", &[]);
        assert_eq!(
            program, "/bin/sh",
            "a spawn must never fail for want of a sandbox"
        );
    }

    #[test]
    fn the_env_override_turns_confinement_off() {
        // Serialised with the other env-reading test by running in one test:
        // cargo runs tests in threads that share the process environment.
        for value in ["0", "off", "false", "no"] {
            std::env::set_var(DISABLE_ENV, value);
            assert!(env_disabled(), "{value} should disable the sandbox");
        }
        std::env::set_var(DISABLE_ENV, "1");
        assert!(!env_disabled());
        std::env::remove_var(DISABLE_ENV);
        assert!(!env_disabled());
    }

    #[test]
    fn status_reports_the_effective_state() {
        let status = status();
        assert!(status.get("enabled").is_some());
        assert!(status.get("allowNetwork").is_some());
        assert!(status.get("confineTerminal").is_some());
    }

    // ---- behavioural: these run a real `sandbox-exec` ----

    #[cfg(target_os = "macos")]
    mod behaviour {
        use super::*;

        fn seatbelt_present() -> bool {
            Path::new(SANDBOX_EXEC).exists()
        }

        fn run(policy: &Policy, script: &str) -> std::process::Output {
            let (program, args) = policy.wrap("/bin/sh", &["-c".to_string(), script.to_string()]);
            std::process::Command::new(program)
                .args(args)
                .output()
                .expect("sandbox-exec should be spawnable")
        }

        fn workspace() -> tempfile::TempDir {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(dir.path().join(".git")).unwrap();
            dir
        }

        #[test]
        fn writes_inside_the_workspace_are_allowed() {
            if !seatbelt_present() {
                return;
            }
            let dir = workspace();
            let root = dir.path().canonicalize().unwrap();
            let policy = workspace_policy(&root, Network::Loopback);
            let target = root.join("allowed.txt");
            let output = run(&policy, &format!("echo ok > '{}'", target.display()));
            assert!(
                output.status.success(),
                "stderr: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(std::fs::read_to_string(&target).unwrap().trim(), "ok");
        }

        #[test]
        fn writes_into_dot_git_are_refused() {
            if !seatbelt_present() {
                return;
            }
            let dir = workspace();
            let root = dir.path().canonicalize().unwrap();
            let policy = workspace_policy(&root, Network::Loopback);
            let target = root.join(".git/HEAD");
            let output = run(&policy, &format!("echo wrecked > '{}'", target.display()));
            assert!(!output.status.success(), "history must stay read-only");
            assert!(!target.exists());
        }

        #[test]
        fn writes_outside_the_workspace_are_refused() {
            if !seatbelt_present() {
                return;
            }
            let dir = workspace();
            let root = dir.path().canonicalize().unwrap();
            let policy = workspace_policy(&root, Network::Loopback);
            let target = crate::config::home_dir()
                .join(format!("cali-sandbox-probe-{}", uuid::Uuid::new_v4()));
            let output = run(&policy, &format!("echo escaped > '{}'", target.display()));
            let existed = target.exists();
            let _ = std::fs::remove_file(&target);
            assert!(
                !output.status.success() && !existed,
                "$HOME must be read-only"
            );
        }

        #[test]
        fn reads_outside_the_workspace_still_work() {
            if !seatbelt_present() {
                return;
            }
            let dir = workspace();
            let root = dir.path().canonicalize().unwrap();
            let policy = workspace_policy(&root, Network::Loopback);
            let output = run(&policy, "cat /etc/hosts");
            assert!(
                output.status.success(),
                "stderr: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        #[test]
        fn loopback_binds_while_egress_is_refused() {
            if !seatbelt_present() || !Path::new("/usr/bin/nc").exists() {
                return;
            }
            let dir = workspace();
            let root = dir.path().canonicalize().unwrap();
            let policy = workspace_policy(&root, Network::Loopback);

            // A free port, released before the confined process claims it.
            let port = {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                listener.local_addr().unwrap().port()
            };
            let (program, args) = policy.wrap(
                "/usr/bin/nc",
                &["-l".to_string(), "127.0.0.1".to_string(), port.to_string()],
            );
            let mut server = std::process::Command::new(program)
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let mut connected = false;
            for _ in 0..50 {
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    connected = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            let _ = server.kill();
            let _ = server.wait();
            assert!(
                connected,
                "a confined dev server must still reach LISTENING"
            );

            // Egress: refused at connect, so this returns immediately rather
            // than timing out — which is also what makes the test offline-safe.
            let output = run(&policy, "/usr/bin/nc -w 1 -z 1.1.1.1 443");
            assert!(!output.status.success(), "outbound network must be refused");
        }

        #[test]
        fn a_hostile_path_still_produces_a_policy_seatbelt_accepts() {
            if !seatbelt_present() {
                return;
            }
            let dir = tempfile::tempdir().unwrap();
            let hostile = dir.path().join(r#"a") (allow default"#);
            std::fs::create_dir_all(&hostile).unwrap();
            let policy = workspace_policy(&hostile, Network::Loopback);
            let output = run(&policy, "echo alive");
            assert!(
                output.status.success(),
                "the profile failed to parse: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "alive");
        }
    }
}

//! Restore points for an unattended run.
//!
//! A `/loop` runs for days against code the user cares about, so the way back
//! from a bad run has to exist before the run starts.
//! [`store::checkpoint_project`] copies `~/.cali/projects/<slug>/`, which is
//! the whole story only for a game with no folder attached. The moment a game
//! owns a `workspaceRoot` — the normal setup when looping on real code —
//! `file_write` and `file_edit` land in THAT folder (see
//! [`crate::tools::game_file_base`]), so a project-directory copy captures the
//! scene document and not one line of the source the agent actually edits. The
//! protection was illusory exactly where it mattered.
//!
//! For an attached folder that is a git repository the snapshot is git's own:
//!
//! * `git stash create` writes a commit object for the working tree and index
//!   and stops there — it moves neither the working tree, the index nor HEAD,
//!   so taking a restore point mid-run changes nothing the user can see. It
//!   prints nothing at all for a clean tree, where HEAD already *is* the
//!   snapshot.
//! * That commit is unreachable, so `refs/calicode/checkpoints/<id>` pins it.
//!   Without a ref, a gc during a three-day run collects the one object that
//!   could undo the run.
//! * Restoring is `git restore --source=<sha> -- .`: tracked files go back to
//!   their snapshot state without HEAD moving and without the user's branch
//!   being rewritten, so every commit made since the restore point is still in
//!   the history afterwards.
//!
//! Objects are shared with the repository, so a snapshot of a tree that barely
//! moved costs almost nothing. That is what makes a restore point per loop
//! iteration affordable where a full directory copy every fifteen minutes was
//! not.
//!
//! What a restore cannot put back is reported instead of papered over: `git
//! stash create` never records untracked files, and a git restore point says
//! nothing about the CaliCode project document. Every result carries a
//! `notCovered` list so the UI can repeat it to the user before they confirm.

use crate::store;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where the commits `git stash create` mints are pinned.
///
/// Under `refs/calicode/` rather than `refs/heads/` or `refs/tags/` so these
/// never show up in the user's branch list, never get pushed by a default
/// `git push`, and can be told apart from anything the user made by hand.
const REF_PREFIX: &str = "refs/calicode/checkpoints/";

/// Id prefixes double as the kind tag: a caller hands back an id and nothing
/// else, and `checkpoint_restore` has to know which mechanism owns it.
const GIT_ID_PREFIX: &str = "git-";
const PROJECT_ID_PREFIX: &str = "cp-";

const KIND_GIT: &str = "git";
const KIND_PROJECT: &str = "project";

/// Ids are spliced into a git ref name and into a filesystem path, so the
/// character set is the intersection of what both accept safely. `.` is
/// excluded on purpose: `..` as a project checkpoint id used to resolve to the
/// project directory itself (see [`store::revert_checkpoint`]), and `..` is
/// also illegal in a ref name.
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 {
        anyhow::bail!("invalid checkpoint id");
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid checkpoint id");
    }
    if id.starts_with('-') {
        anyhow::bail!("invalid checkpoint id");
    }
    Ok(())
}

/// Run git in `directory` and return stdout.
///
/// Deliberately NOT routed through [`crate::sandbox`], and it must stay that
/// way. The Seatbelt profile makes `.git` read-only inside every writable root
/// so that a dev server, an MCP server or a one-shot shell command cannot
/// destroy the history a bad run is undone with. Core's own git is the other
/// half of that bargain — it is the code *writing* the restore points — and
/// confining it here would leave the guard blocking the rescue instead of the
/// accident. This reads like an oversight; it is not.
fn git(directory: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .output()
        .context("failed to run git")?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(if detail.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            detail
        });
    }
    String::from_utf8(output.stdout).context("git returned non-UTF-8 output")
}

/// The folder a game's file tools write into, when it has one.
fn attached_workspace(project: &Value) -> Option<PathBuf> {
    project
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

/// The repository a game's restore points belong to, if any.
///
/// Resolved with `rev-parse --show-toplevel` rather than by looking for a
/// `.git` directory: an attached folder is often a subdirectory of the repo,
/// and inside a linked worktree `.git` is a file. Both are real repositories
/// and both must get git-backed restore points. The snapshot is repo-wide
/// because `git stash create` is repo-wide, so every operation runs at the
/// toplevel and results report it.
fn git_repo_for(root: &Path, slug: &str) -> Result<Option<PathBuf>> {
    let project = store::read_project(root, slug)?;
    let Some(workspace) = attached_workspace(&project) else {
        return Ok(None);
    };
    let Ok(toplevel) = git(&workspace, &["rev-parse", "--show-toplevel"]) else {
        return Ok(None);
    };
    let toplevel = PathBuf::from(toplevel.trim());
    if toplevel.as_os_str().is_empty() {
        return Ok(None);
    }
    Ok(Some(toplevel))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

/// `<prefix><millis>` optionally followed by `-<n>` from collision handling.
fn stamp_of(id: &str, prefix: &str) -> Option<(i64, u32)> {
    let rest = id.strip_prefix(prefix)?;
    let (millis, seq) = match rest.split_once('-') {
        Some((millis, seq)) => (millis, seq.parse::<u32>().ok()?),
        None => (rest, 0),
    };
    Some((millis.parse::<i64>().ok()?, seq))
}

fn untracked_count(repo: &Path) -> usize {
    git(repo, &["ls-files", "--others", "--exclude-standard"])
        .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0)
}

/// The sentence a git restore point owes the user about the project document.
///
/// A workspace-attached game keeps its scene, scripts and assets in
/// `~/.cali/projects/<slug>/` while its source lives in the repository. A git
/// restore point covers the second and not the first, and a half-restore the
/// user was not told about is worse than no restore point at all.
fn project_document_note(slug: &str, repo: &Path) -> String {
    format!(
        "the CaliCode project document for {slug} (scene, scripts, assets) — this restore point covers {} only",
        repo.display()
    )
}

fn untracked_note(count: usize, repo: &Path) -> String {
    format!(
        "{count} untracked file(s) under {} — `git stash create` does not capture untracked files, so a restore neither brings them back nor removes them",
        repo.display()
    )
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/// Take a restore point, picking the mechanism from what the game actually
/// has. One entry point so a caller never has to know which it got.
pub fn create(root: &Path, slug: &str) -> Result<Value> {
    match git_repo_for(root, slug)? {
        Some(repo) => create_git(root, slug, &repo),
        None => create_project_copy(root, slug),
    }
}

fn create_git(root: &Path, slug: &str, repo: &Path) -> Result<Value> {
    // A repository with no commits yet has nothing to snapshot against:
    // `stash create` declines and there is no HEAD to fall back to. Copy the
    // project directory instead of failing the call — the loop that asked for
    // this is about to run either way — and say plainly that the source files
    // are not in it.
    let Ok(head) = git(repo, &["rev-parse", "--verify", "HEAD"]) else {
        let mut result = create_project_copy(root, slug)?;
        push_note(
            &mut result,
            format!(
                "the attached folder {} — it is a git repository with no commits yet, so there is nothing to snapshot against",
                repo.display()
            ),
        );
        return Ok(result);
    };

    // Empty output means a clean tree, where HEAD already describes it.
    let stashed = git(repo, &["stash", "create"])?;
    let sha = match stashed.trim() {
        "" => head.trim().to_string(),
        sha => sha.to_string(),
    };

    let id = allocate_git_id(repo)?;
    git(
        repo,
        &[
            "update-ref",
            "-m",
            "calicode restore point",
            &format!("{REF_PREFIX}{id}"),
            &sha,
        ],
    )?;

    let created_at_ms = stamp_of(&id, GIT_ID_PREFIX).map_or_else(now_millis, |(millis, _)| millis);
    let subject = git(repo, &["log", "-1", "--format=%s", &sha])
        .map(|text| text.trim().to_string())
        .unwrap_or_default();

    let mut not_covered = vec![project_document_note(slug, repo)];
    let untracked = untracked_count(repo);
    if untracked > 0 {
        not_covered.push(untracked_note(untracked, repo));
    }

    Ok(json!({
        "id": id,
        "kind": KIND_GIT,
        "createdAtMs": created_at_ms,
        "sha": sha,
        "subject": subject,
        "root": repo.display().to_string(),
        "notCovered": not_covered,
    }))
}

/// Millisecond stamps collide under a fast loop. Suffix rather than reuse: an
/// id that silently points at another restore point's commit is worse than no
/// id, because it restores the wrong tree without complaining.
fn allocate_git_id(repo: &Path) -> Result<String> {
    let stamp = now_millis();
    for attempt in 0..1000 {
        let id = if attempt == 0 {
            format!("{GIT_ID_PREFIX}{stamp}")
        } else {
            format!("{GIT_ID_PREFIX}{stamp}-{attempt}")
        };
        let taken = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["show-ref", "--verify", "--quiet"])
            .arg(format!("{REF_PREFIX}{id}"))
            .status()
            .context("failed to inspect git refs")?
            .success();
        if !taken {
            return Ok(id);
        }
    }
    anyhow::bail!("unable to allocate a checkpoint id")
}

fn create_project_copy(root: &Path, slug: &str) -> Result<Value> {
    let created = store::checkpoint_project(root, slug)?;
    let id = created
        .get("id")
        .and_then(Value::as_str)
        .context("checkpoint returned no id")?
        .to_string();
    let created_at_ms =
        stamp_of(&id, PROJECT_ID_PREFIX).map_or_else(now_millis, |(millis, _)| millis);

    let project = store::read_project(root, slug)?;
    let mut not_covered = Vec::new();
    if let Some(workspace) = attached_workspace(&project) {
        not_covered.push(format!(
            "the attached folder {} — the agent's file edits land there, and this restore point copies the CaliCode project directory only",
            workspace.display()
        ));
    }

    Ok(json!({
        "id": id,
        "kind": KIND_PROJECT,
        "createdAtMs": created_at_ms,
        "root": store::project_dir(root, slug)?.display().to_string(),
        "notCovered": not_covered,
    }))
}

fn push_note(result: &mut Value, note: String) {
    if let Some(list) = result
        .get_mut("notCovered")
        .and_then(Value::as_array_mut)
        .filter(|list| !list.iter().any(|item| item.as_str() == Some(&note)))
    {
        list.push(Value::String(note));
    }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

struct Entry {
    id: String,
    kind: &'static str,
    created_at_ms: i64,
    seq: u32,
    sha: Option<String>,
    subject: Option<String>,
}

impl Entry {
    fn to_json(&self) -> Value {
        let mut value = json!({
            "id": self.id,
            "kind": self.kind,
            "createdAtMs": self.created_at_ms,
        });
        let object = value.as_object_mut().expect("entry is an object");
        if let Some(sha) = &self.sha {
            object.insert("sha".into(), json!(sha));
        }
        if let Some(subject) = &self.subject {
            object.insert("subject".into(), json!(subject));
        }
        value
    }
}

/// Every restore point a game has, newest first, across both mechanisms.
///
/// Nothing enumerated these before, which is why the client kept its own
/// localStorage registry of ids it happened to have created — restore points
/// taken by another window, by the agent, or before the browser's storage was
/// cleared were unreachable even though they were sitting on disk.
pub fn list(root: &Path, slug: &str) -> Result<Value> {
    let mut entries = Vec::new();
    if let Some(repo) = git_repo_for(root, slug)? {
        entries.extend(list_git(&repo));
    }
    entries.extend(list_project_copies(root, slug)?);
    sort_newest_first(&mut entries);
    Ok(json!({
        "checkpoints": entries.iter().map(Entry::to_json).collect::<Vec<_>>(),
    }))
}

fn sort_newest_first(entries: &mut [Entry]) {
    entries.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then(right.seq.cmp(&left.seq))
            .then(right.id.cmp(&left.id))
    });
}

/// A repository that has gone missing or become unreadable must not fail the
/// listing: the project copies are still valid restore points and the user
/// still needs to see them.
fn list_git(repo: &Path) -> Vec<Entry> {
    let Ok(text) = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(subject)",
            REF_PREFIX,
        ],
    ) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let mut fields = line.splitn(4, '\t');
            let refname = fields.next()?;
            let sha = fields.next()?.trim().to_string();
            let committed = fields.next().unwrap_or_default().trim().parse::<i64>().ok();
            let subject = fields.next().unwrap_or_default().trim().to_string();
            let id = refname.strip_prefix(REF_PREFIX)?.to_string();
            if validate_id(&id).is_err() {
                return None;
            }
            let (created_at_ms, seq) = stamp_of(&id, GIT_ID_PREFIX)
                .unwrap_or_else(|| (committed.unwrap_or_default().saturating_mul(1000), 0));
            Some(Entry {
                id,
                kind: KIND_GIT,
                created_at_ms,
                seq,
                sha: Some(sha),
                subject: Some(subject),
            })
        })
        .collect()
}

fn list_project_copies(root: &Path, slug: &str) -> Result<Vec<Entry>> {
    let directory = store::project_dir(root, slug)?.join("checkpoints");
    let Ok(read) = std::fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::new();
    for item in read.flatten() {
        if !item.path().is_dir() {
            continue;
        }
        let id = item.file_name().to_string_lossy().to_string();
        if validate_id(&id).is_err() {
            continue;
        }
        // A directory whose name carries no stamp still gets listed — it is a
        // real restore point — dated from the filesystem instead.
        let (created_at_ms, seq) = stamp_of(&id, PROJECT_ID_PREFIX).unwrap_or_else(|| {
            let millis = item
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_millis().min(i64::MAX as u128) as i64)
                .unwrap_or_default();
            (millis, 0)
        });
        entries.push(Entry {
            id,
            kind: KIND_PROJECT,
            created_at_ms,
            seq,
            sha: None,
            subject: None,
        });
    }
    Ok(entries)
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

/// Put a game back to a restore point. Destructive by definition; confirming
/// is the client's job, and the result names what was replaced so the UI can
/// say it afterwards too.
pub fn restore(root: &Path, slug: &str, id: &str) -> Result<Value> {
    validate_id(id)?;
    if id.starts_with(GIT_ID_PREFIX) {
        let repo = git_repo_for(root, slug)?.with_context(|| {
            format!(
                "checkpoint {id} is a git restore point, but {slug} has no attached git repository"
            )
        })?;
        return restore_git(slug, &repo, id);
    }
    restore_project_copy(root, slug, id)
}

fn restore_git(slug: &str, repo: &Path, id: &str) -> Result<Value> {
    let sha = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{REF_PREFIX}{id}^{{commit}}"),
        ],
    )
    .ok()
    .map(|text| text.trim().to_string())
    .filter(|text| !text.is_empty())
    .with_context(|| format!("checkpoint {id} not found"))?;

    let changed = git(repo, &["diff", "--name-only", &sha, "--", "."])
        .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0);
    let untracked = untracked_count(repo);

    // `--worktree` is the default, spelled out because the index deliberately
    // stays where it is: the user's staged work and their branch are not this
    // feature's to rewrite, and leaving HEAD alone is what keeps every commit
    // made during the run recoverable after a restore.
    git(
        repo,
        &["restore", "--worktree", "--source", &sha, "--", "."],
    )?;

    let mut not_covered = vec![project_document_note(slug, repo)];
    if untracked > 0 {
        not_covered.push(untracked_note(untracked, repo));
    }

    Ok(json!({
        "restored": true,
        "kind": KIND_GIT,
        "id": id,
        "sha": sha,
        "root": repo.display().to_string(),
        "fileCount": changed,
        "replaced": [
            format!(
                "{changed} tracked file(s) under {} were rewritten to their state at the restore point, including files that were created since it",
                repo.display()
            ),
            "HEAD and the current branch were not moved, so every commit made since the restore point is still in the history".to_string(),
        ],
        "notCovered": not_covered,
    }))
}

fn restore_project_copy(root: &Path, slug: &str, id: &str) -> Result<Value> {
    let project = store::revert_checkpoint(root, slug, id)?;
    let directory = store::project_dir(root, slug)?;
    let mut not_covered = Vec::new();
    if let Some(workspace) = attached_workspace(&project) {
        not_covered.push(format!(
            "the attached folder {} — the agent's file edits land there, and this restore point never copied it",
            workspace.display()
        ));
    }
    Ok(json!({
        "restored": true,
        "kind": KIND_PROJECT,
        "id": id,
        "root": directory.display().to_string(),
        "replaced": [format!(
            "project.json, scripts/, assets/, tests/, baselines/ and thumbnails/ under {} were replaced with the copies taken at the restore point",
            directory.display()
        )],
        "notCovered": not_covered,
        "project": project,
    }))
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

/// Keep the newest `keep` restore points and drop the rest.
///
/// Without this a three-day run at one restore point every fifteen minutes
/// leaves roughly 288 full copies of the project directory on disk. Only
/// CaliCode's own restore points are eligible — refs under
/// `refs/calicode/checkpoints/` and directories under `<project>/checkpoints/`
/// — so the user's stashes, branches and tags are never in scope.
///
/// `keep` must be at least one. A client bug that sent `0` would delete every
/// restore point in the middle of the run it was protecting, and there is no
/// way back from that.
pub fn prune(root: &Path, slug: &str, keep: usize) -> Result<Value> {
    if keep == 0 {
        anyhow::bail!("keep must be at least 1");
    }
    let repo = git_repo_for(root, slug)?;
    let mut entries = Vec::new();
    if let Some(repo) = &repo {
        entries.extend(list_git(repo));
    }
    entries.extend(list_project_copies(root, slug)?);
    sort_newest_first(&mut entries);

    let checkpoints = store::project_dir(root, slug)?.join("checkpoints");
    let mut removed = 0usize;
    for entry in entries.iter().skip(keep) {
        let dropped = match entry.kind {
            KIND_GIT => repo.as_ref().is_some_and(|repo| {
                git(
                    repo,
                    &["update-ref", "-d", &format!("{REF_PREFIX}{}", entry.id)],
                )
                .is_ok()
            }),
            _ => std::fs::remove_dir_all(checkpoints.join(&entry.id)).is_ok(),
        };
        if dropped {
            removed += 1;
        } else {
            tracing::warn!(slug, id = %entry.id, "could not prune restore point");
        }
    }
    Ok(json!({
        "removed": removed,
        "kept": entries.len().min(keep),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_carry_the_time_they_were_taken() {
        assert_eq!(
            stamp_of("git-1723600000000", GIT_ID_PREFIX),
            Some((1_723_600_000_000, 0))
        );
        assert_eq!(
            stamp_of("git-1723600000000-7", GIT_ID_PREFIX),
            Some((1_723_600_000_000, 7))
        );
        assert_eq!(
            stamp_of("cp-1723600000000", PROJECT_ID_PREFIX),
            Some((1_723_600_000_000, 0))
        );
        assert_eq!(stamp_of("cp-not-a-stamp", PROJECT_ID_PREFIX), None);
        assert_eq!(stamp_of("git-1", PROJECT_ID_PREFIX), None);
    }

    /// An id becomes both a git ref component and a path component, so the
    /// traversal that once let `..` delete a project's contents must stay dead.
    #[test]
    fn ids_that_could_escape_are_refused() {
        for id in [
            "",
            "..",
            "../evil",
            "cp-1/../..",
            "refs/heads/main",
            "-d",
            "a b",
        ] {
            assert!(validate_id(id).is_err(), "id {id:?} must be rejected");
        }
        assert!(validate_id("git-1723600000000-3").is_ok());
        assert!(validate_id("cp-1723600000000").is_ok());
    }

    #[test]
    fn prune_refuses_to_keep_nothing() {
        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        let error = prune(root.path(), "demo", 0).unwrap_err().to_string();
        assert!(error.contains("at least 1"), "{error}");
    }

    #[test]
    fn newest_first_breaks_stamp_ties_by_sequence() {
        let mut entries = vec![
            Entry {
                id: "cp-10".into(),
                kind: KIND_PROJECT,
                created_at_ms: 10,
                seq: 0,
                sha: None,
                subject: None,
            },
            Entry {
                id: "git-10-12".into(),
                kind: KIND_GIT,
                created_at_ms: 10,
                seq: 12,
                sha: None,
                subject: None,
            },
            Entry {
                id: "git-10-2".into(),
                kind: KIND_GIT,
                created_at_ms: 10,
                seq: 2,
                sha: None,
                subject: None,
            },
            Entry {
                id: "cp-99".into(),
                kind: KIND_PROJECT,
                created_at_ms: 99,
                seq: 0,
                sha: None,
                subject: None,
            },
        ];
        sort_newest_first(&mut entries);
        let order: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(order, ["cp-99", "git-10-12", "git-10-2", "cp-10"]);
    }
}

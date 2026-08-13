//! Durable progress records for CaliCode's iterative build/play/judge loop.
//!
//! JSON is the source of truth. Every mutation also refreshes deterministic
//! Markdown and standalone HTML views under the owning project's
//! `reports/loops/<loop-id>/` directory.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use uuid::Uuid;

pub const LOOP_REPORT_SCHEMA_VERSION: u32 = 1;
const MAX_LOOP_ID_LEN: usize = 64;
const MAX_AGENT_ID_LEN: usize = 96;
const MAX_PATH_LEN: usize = 512;
const MAX_PATH_COMPONENTS: usize = 48;
const MAX_OBJECTIVE_LEN: usize = 16 * 1024;
const MAX_TEXT_LEN: usize = 64 * 1024;
const MAX_SHORT_TEXT_LEN: usize = 4 * 1024;
const MAX_ITERATIONS: usize = 10_000;

/// Minimum number of iterations a loop must have completed before it can be
/// terminalised as `Completed`. A single iteration cannot stand on its own:
/// the loop exists to refine across passes, and a one-shot report carries
/// no signal that the work has actually been reviewed and converged.
const COMPLETION_MIN_ITERATIONS: usize = 2;

/// Default score threshold the latest iteration's scores must clear when no
/// explicit `passThreshold` is set. Live judges aim for 90; that bar is
/// kept here so the same number appears in both the prompt and the on-disk
/// invariant.
const COMPLETION_DEFAULT_SCORE_THRESHOLD: u32 = 90;

/// Rewrite snake_case keys on a raw `loop_report_iteration` payload to the
/// camelCase names the structs serialise as. Models that lack the schema
/// description fall back to snake_case (a strict coordinator did this
/// three times before the fallback appended a generic iteration), so the
/// dispatch accepts either naming. Existing on-disk reports stay camelCase
/// because nothing here is ever round-tripped to disk.
pub fn normalize_iteration_payload(value: serde_json::Value) -> serde_json::Value {
    camelize_value(value)
}

/// Same as [`normalize_iteration_payload`] but for the `update` half of the
/// tool. The `LoopUpdate` struct only has two snake_case fields today;
/// centralising the rename here means a future field stays normalised for
/// free.
pub fn normalize_update_payload(value: serde_json::Value) -> serde_json::Value {
    camelize_value(value)
}

fn camelize_value(value: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, inner) in map {
                let renamed = if key.contains('_') {
                    camelize_key(&key)
                } else {
                    key
                };
                out.insert(renamed, camelize_value(inner));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(camelize_value).collect()),
        other => other,
    }
}

fn camelize_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut at_boundary = false;
    for character in key.chars() {
        if character == '_' {
            at_boundary = true;
            continue;
        }
        if at_boundary {
            out.extend(character.to_uppercase());
            at_boundary = false;
        } else {
            out.push(character);
        }
    }
    out
}

// The core is a single process, but RPC and graph workers mutate reports from
// different threads. A process-wide lock makes every read/modify/replace one
// transaction and prevents a later writer from dropping an earlier append.
static REPORT_IO_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum LoopStatus {
    #[default]
    Running,
    Completed,
    Blocked,
    Cancelled,
}

impl LoopStatus {
    fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }

    fn label(self) -> &'static str {
        match self {
            Self::Running => "Running",
            Self::Completed => "Completed",
            Self::Blocked => "Blocked",
            Self::Cancelled => "Cancelled",
        }
    }

    fn css_class(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "passed",
            Self::Blocked => "failed",
            Self::Cancelled => "muted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IterationOutcome {
    Passed,
    NeedsWork,
    Failed,
    Cancelled,
}

impl IterationOutcome {
    fn label(self) -> &'static str {
        match self {
            Self::Passed => "Passed",
            Self::NeedsWork => "Needs work",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }

    fn css_class(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::NeedsWork => "warning",
            Self::Failed => "failed",
            Self::Cancelled => "muted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentOutcome {
    Passed,
    Failed,
    Cancelled,
}

impl AgentOutcome {
    fn label(self) -> &'static str {
        match self {
            Self::Passed => "Passed",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckKind {
    Build,
    Test,
    Lint,
    Play,
    Performance,
    Other,
}

impl CheckKind {
    fn label(self) -> &'static str {
        match self {
            Self::Build => "Build",
            Self::Test => "Test",
            Self::Lint => "Lint",
            Self::Play => "Play",
            Self::Performance => "Performance",
            Self::Other => "Other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckStatus {
    Passed,
    Failed,
    Skipped,
}

impl CheckStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Passed => "Passed",
            Self::Failed => "Failed",
            Self::Skipped => "Skipped",
        }
    }

    fn css_class(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Skipped => "muted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceKind {
    Screenshot,
    Video,
    ContactSheet,
    Trace,
    Log,
    Other,
}

impl EvidenceKind {
    fn label(self) -> &'static str {
        match self {
            Self::Screenshot => "Screenshot",
            Self::Video => "Video",
            Self::ContactSheet => "Contact sheet",
            Self::Trace => "Trace",
            Self::Log => "Log",
            Self::Other => "Other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PunchPriority {
    Critical,
    High,
    Medium,
    Low,
}

impl PunchPriority {
    fn label(self) -> &'static str {
        match self {
            Self::Critical => "Critical",
            Self::High => "High",
            Self::Medium => "Medium",
            Self::Low => "Low",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    /// Stable orchestration role, such as `gameplay-engineer` or `critic`.
    pub role: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub task: String,
    pub outcome: AgentOutcome,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub kind: CheckKind,
    pub name: String,
    #[serde(default)]
    pub command: Option<String>,
    pub status: CheckStatus,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub details: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Relative to the attached game workspace or project directory.
    pub path: String,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub kind: EvidenceKind,
    /// Relative to the report directory or owning project directory.
    pub path: String,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub captured_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveScore {
    pub criterion: String,
    pub score: u32,
    #[serde(default = "default_score_maximum")]
    pub maximum: u32,
    #[serde(default)]
    pub pass_threshold: Option<u32>,
    #[serde(default)]
    pub rationale: String,
}

fn default_score_maximum() -> u32 {
    100
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PunchItem {
    pub priority: PunchPriority,
    pub item: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub resolved: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextIterationMemory {
    #[serde(default)]
    pub observations: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub next_actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IterationReport {
    /// One-based and contiguous. Assigned by `append_iteration`.
    pub iteration: u32,
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub duration_ms: u64,
    pub outcome: IterationOutcome,
    pub summary: String,
    #[serde(default)]
    pub agents: Vec<AgentRun>,
    #[serde(default)]
    pub checks: Vec<CheckResult>,
    #[serde(default)]
    pub changed_files: Vec<ChangedFile>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub scores: Vec<ObjectiveScore>,
    #[serde(default)]
    pub punch_list: Vec<PunchItem>,
    #[serde(default)]
    pub next_iteration_memory: NextIterationMemory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IterationInput {
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub outcome: IterationOutcome,
    pub summary: String,
    #[serde(default)]
    pub agents: Vec<AgentRun>,
    #[serde(default)]
    pub checks: Vec<CheckResult>,
    #[serde(default)]
    pub changed_files: Vec<ChangedFile>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub scores: Vec<ObjectiveScore>,
    #[serde(default)]
    pub punch_list: Vec<PunchItem>,
    #[serde(default)]
    pub next_iteration_memory: NextIterationMemory,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopTotals {
    pub iterations: u32,
    pub worked_duration_ms: u64,
    pub elapsed_duration_ms: u64,
    pub agents: u32,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_skipped: u32,
    pub files_changed: u32,
    pub additions: u64,
    pub deletions: u64,
    #[serde(default)]
    pub latest_score_percent: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopReport {
    pub schema_version: u32,
    pub project_slug: String,
    pub loop_id: String,
    pub objective: String,
    #[serde(default)]
    pub reference: Option<String>,
    pub status: LoopStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub started_at_ms: u64,
    #[serde(default)]
    pub completed_at_ms: Option<u64>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub punch_list: Vec<PunchItem>,
    #[serde(default)]
    pub next_iteration_memory: NextIterationMemory,
    #[serde(default)]
    pub iterations: Vec<IterationReport>,
    #[serde(default)]
    pub totals: LoopTotals,
}

/// Compact metadata used to discover reports without loading every iteration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopReportSummary {
    pub loop_id: String,
    pub objective: String,
    pub status: LoopStatus,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default)]
    pub completed_at_ms: Option<u64>,
    pub totals: LoopTotals,
}

impl From<&LoopReport> for LoopReportSummary {
    fn from(report: &LoopReport) -> Self {
        Self {
            loop_id: report.loop_id.clone(),
            objective: report.objective.clone(),
            status: report.status,
            started_at_ms: report.started_at_ms,
            updated_at_ms: report.updated_at_ms,
            completed_at_ms: report.completed_at_ms,
            totals: report.totals.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewLoopReport {
    pub objective: String,
    #[serde(default)]
    pub reference: Option<String>,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopUpdate {
    #[serde(default)]
    pub status: Option<LoopStatus>,
    #[serde(default)]
    pub completed_at_ms: Option<u64>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub punch_list: Option<Vec<PunchItem>>,
    #[serde(default)]
    pub next_iteration_memory: Option<NextIterationMemory>,
    /// Defaults to wall-clock time. Supplying it makes replay/tests exact.
    #[serde(default)]
    pub recorded_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportPaths {
    pub directory: PathBuf,
    pub json: PathBuf,
    pub markdown: PathBuf,
    pub html: PathBuf,
}

/// Create a report and all three durable representations.
pub fn create(
    projects_root: &Path,
    project_slug: &str,
    loop_id: &str,
    new_report: NewLoopReport,
) -> Result<LoopReport> {
    let _guard = io_guard()?;
    let paths = report_paths(projects_root, project_slug, loop_id)?;
    ensure_project_exists(projects_root, project_slug)?;
    if paths.json.exists() {
        let mut existing = read_report_unlocked(&paths, project_slug, loop_id)?;
        if existing.status != LoopStatus::Running {
            anyhow::bail!("loop report {loop_id} is already terminal for project {project_slug}");
        }
        match (&existing.reference, &new_report.reference) {
            (Some(existing_reference), Some(requested_reference))
                if existing_reference != requested_reference =>
            {
                anyhow::bail!("loop report {loop_id} already exists with a different reference");
            }
            (None, Some(reference)) => {
                existing.reference = Some(reference.clone());
                validate_report(&existing)?;
                write_bundle_atomic(&paths, &existing)?;
            }
            _ => {}
        }
        return Ok(existing);
    }

    let mut report = LoopReport {
        schema_version: LOOP_REPORT_SCHEMA_VERSION,
        project_slug: project_slug.to_string(),
        loop_id: loop_id.to_string(),
        objective: new_report.objective,
        reference: new_report.reference,
        status: LoopStatus::Running,
        created_at_ms: new_report.started_at_ms,
        updated_at_ms: new_report.started_at_ms,
        started_at_ms: new_report.started_at_ms,
        completed_at_ms: None,
        summary: String::new(),
        punch_list: Vec::new(),
        next_iteration_memory: NextIterationMemory::default(),
        iterations: Vec::new(),
        totals: LoopTotals::default(),
    };
    refresh_totals(&mut report);
    validate_report(&report)?;
    write_bundle_atomic(&paths, &report)?;
    Ok(report)
}

/// Read and validate the JSON source of truth.
pub fn load(projects_root: &Path, project_slug: &str, loop_id: &str) -> Result<LoopReport> {
    let _guard = io_guard()?;
    let paths = report_paths(projects_root, project_slug, loop_id)?;
    read_report_unlocked(&paths, project_slug, loop_id)
}

/// List validated reports, newest update first. A corrupt entry fails closed
/// instead of silently presenting stale or partially written progress.
pub fn list(projects_root: &Path, project_slug: &str) -> Result<Vec<LoopReportSummary>> {
    let _guard = io_guard()?;
    let project_slug = crate::store::sanitize_slug(project_slug)?;
    ensure_project_exists(projects_root, &project_slug)?;
    let directory = crate::store::project_dir(projects_root, &project_slug)?
        .join("reports")
        .join("loops");
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut reports = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let loop_id = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("loop report directory name is not UTF-8"))?;
        validate_component_id("loop id", &loop_id, MAX_LOOP_ID_LEN, true)?;
        let paths = report_paths(projects_root, &project_slug, &loop_id)?;
        let report = read_report_unlocked(&paths, &project_slug, &loop_id)?;
        reports.push(LoopReportSummary::from(&report));
    }
    reports.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| right.started_at_ms.cmp(&left.started_at_ms))
            .then_with(|| left.loop_id.cmp(&right.loop_id))
    });
    Ok(reports)
}

/// Append one completed iteration without losing concurrent writers.
pub fn append_iteration(
    projects_root: &Path,
    project_slug: &str,
    loop_id: &str,
    input: IterationInput,
) -> Result<LoopReport> {
    let _guard = io_guard()?;
    let paths = report_paths(projects_root, project_slug, loop_id)?;
    let mut report = read_report_unlocked(&paths, project_slug, loop_id)?;
    if report.status != LoopStatus::Running {
        anyhow::bail!(
            "cannot append to {status} loop report",
            status = report.status.label().to_ascii_lowercase()
        );
    }
    if report.iterations.len() >= MAX_ITERATIONS {
        anyhow::bail!("loop report exceeds the {MAX_ITERATIONS} iteration limit");
    }
    validate_iteration_input(&input, report.started_at_ms)?;

    let next = report.iterations.len() as u32 + 1;
    report.iterations.push(IterationReport {
        iteration: next,
        started_at_ms: input.started_at_ms,
        completed_at_ms: input.completed_at_ms,
        duration_ms: input.completed_at_ms - input.started_at_ms,
        outcome: input.outcome,
        summary: input.summary,
        agents: input.agents,
        checks: input.checks,
        changed_files: input.changed_files,
        evidence: input.evidence,
        scores: input.scores,
        punch_list: input.punch_list,
        next_iteration_memory: input.next_iteration_memory,
    });
    report.updated_at_ms = report.updated_at_ms.max(input.completed_at_ms);
    refresh_totals(&mut report);
    validate_report(&report)?;
    write_bundle_atomic(&paths, &report)?;
    Ok(report)
}

/// Update loop-level status, summary, punch list, or carry-forward memory.
pub fn update(
    projects_root: &Path,
    project_slug: &str,
    loop_id: &str,
    update: LoopUpdate,
) -> Result<LoopReport> {
    let _guard = io_guard()?;
    let paths = report_paths(projects_root, project_slug, loop_id)?;
    let mut report = read_report_unlocked(&paths, project_slug, loop_id)?;
    let recorded_at = update.recorded_at_ms.unwrap_or_else(now_ms);
    // A report can only reach `Completed` from a non-terminal state when the
    // caller supplies fresh completion evidence. Re-saving an already
    // terminal report (status-only or summary-only follow-ups) must keep
    // working so the AgentPanel terminal handlers can rewrite their summary
    // without re-asserting every check.
    let was_terminal_before = report.status.is_terminal();

    if let Some(status) = update.status {
        report.status = status;
    }
    if let Some(summary) = update.summary {
        report.summary = summary;
    }
    if let Some(punch_list) = update.punch_list {
        report.punch_list = punch_list;
    }
    if let Some(memory) = update.next_iteration_memory {
        report.next_iteration_memory = memory;
    }
    if let Some(completed_at) = update.completed_at_ms {
        report.completed_at_ms = Some(completed_at);
    }
    if report.status.is_terminal() && report.completed_at_ms.is_none() {
        anyhow::bail!("a terminal loop status requires completedAtMs");
    }
    if report.status == LoopStatus::Running && report.completed_at_ms.is_some() {
        anyhow::bail!("a running loop cannot have completedAtMs");
    }
    // Block a model from short-circuiting a loop into `Completed` without
    // durable proof. The AgentPanel terminal-completion path already passes
    // `validateLoopGraphCompletion`; a tool call from a strict coordinator
    // does not, and the report must fail closed instead of looking finished.
    if update.status == Some(LoopStatus::Completed) && !was_terminal_before {
        validate_completion_readiness(&report)?;
    }
    report.updated_at_ms = report.updated_at_ms.max(recorded_at);
    if let Some(completed_at) = report.completed_at_ms {
        report.updated_at_ms = report.updated_at_ms.max(completed_at);
    }
    refresh_totals(&mut report);
    validate_report(&report)?;
    write_bundle_atomic(&paths, &report)?;
    Ok(report)
}

/// Canonical on-disk locations. Validates every path-bearing identifier first.
pub fn report_paths(
    projects_root: &Path,
    project_slug: &str,
    loop_id: &str,
) -> Result<ReportPaths> {
    let project_slug = crate::store::sanitize_slug(project_slug)?;
    validate_component_id("loop id", loop_id, MAX_LOOP_ID_LEN, true)?;
    let directory = crate::store::project_dir(projects_root, &project_slug)?
        .join("reports")
        .join("loops")
        .join(loop_id);
    Ok(ReportPaths {
        json: directory.join("report.json"),
        markdown: directory.join("report.md"),
        html: directory.join("report.html"),
        directory,
    })
}

/// Deterministic Markdown projection of a report.
pub fn render_markdown(report: &LoopReport) -> String {
    let mut out = String::new();
    writeln!(out, "# CaliCode loop report").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "- Project: `{}`", md_inline(&report.project_slug)).unwrap();
    writeln!(out, "- Loop: `{}`", md_inline(&report.loop_id)).unwrap();
    writeln!(out, "- Status: **{}**", report.status.label()).unwrap();
    writeln!(
        out,
        "- Started: {}",
        format_timestamp_ms(report.started_at_ms)
    )
    .unwrap();
    writeln!(
        out,
        "- Updated: {}",
        format_timestamp_ms(report.updated_at_ms)
    )
    .unwrap();
    if let Some(completed_at) = report.completed_at_ms {
        writeln!(out, "- Completed: {}", format_timestamp_ms(completed_at)).unwrap();
    }
    writeln!(
        out,
        "- Worked: {} across {} iteration{}",
        format_duration(report.totals.worked_duration_ms),
        report.totals.iterations,
        plural(report.totals.iterations)
    )
    .unwrap();
    writeln!(
        out,
        "- Changes: {} file{} (+{} -{})",
        report.totals.files_changed,
        plural(report.totals.files_changed),
        report.totals.additions,
        report.totals.deletions
    )
    .unwrap();
    writeln!(out).unwrap();
    writeln!(out, "## Objective").unwrap();
    writeln!(out).unwrap();
    write_markdown_paragraph(&mut out, &report.objective);
    if let Some(reference) = &report.reference {
        writeln!(out).unwrap();
        writeln!(out, "Reference: {}", md_inline(reference)).unwrap();
    }
    if !report.summary.is_empty() {
        writeln!(out).unwrap();
        writeln!(out, "## Outcome").unwrap();
        writeln!(out).unwrap();
        write_markdown_paragraph(&mut out, &report.summary);
    }

    if let Some(scores) = latest_scores(report) {
        writeln!(out).unwrap();
        writeln!(out, "## Latest objective scores").unwrap();
        writeln!(out).unwrap();
        writeln!(out, "| Criterion | Score | Pass | Rationale |").unwrap();
        writeln!(out, "| --- | ---: | ---: | --- |").unwrap();
        for score in scores {
            let threshold = score
                .pass_threshold
                .map(|value| value.to_string())
                .unwrap_or_else(|| "—".into());
            writeln!(
                out,
                "| {} | {}/{} | {} | {} |",
                md_table(&score.criterion),
                score.score,
                score.maximum,
                threshold,
                md_table(&score.rationale)
            )
            .unwrap();
        }
    }

    for iteration in &report.iterations {
        render_markdown_iteration(&mut out, iteration);
    }

    if !report.punch_list.is_empty() {
        render_markdown_punch_list(&mut out, "Final punch list", &report.punch_list);
    }
    if !memory_is_empty(&report.next_iteration_memory) {
        render_markdown_memory(
            &mut out,
            "Carry-forward memory",
            &report.next_iteration_memory,
        );
    }
    out
}

/// Deterministic, dependency-free HTML that can be opened directly from disk.
pub fn render_html(report: &LoopReport) -> String {
    let mut out = String::new();
    out.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n");
    out.push_str("<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n");
    out.push_str("<title>CaliCode loop report — ");
    out.push_str(&html_text(&report.loop_id));
    out.push_str("</title>\n<style>\n");
    out.push_str(HTML_STYLE);
    out.push_str("\n</style>\n</head>\n<body>\n<main>\n");
    writeln!(
        out,
        "<header><div><p class=\"eyebrow\">CaliCode / {}</p><h1>Loop report</h1></div><span class=\"badge {}\">{}</span></header>",
        html_text(&report.project_slug),
        report.status.css_class(),
        report.status.label()
    )
    .unwrap();
    out.push_str("<section class=\"summary-grid\" aria-label=\"Loop summary\">\n");
    html_metric(
        &mut out,
        "Worked",
        &format_duration(report.totals.worked_duration_ms),
    );
    html_metric(
        &mut out,
        "Iterations",
        &report.totals.iterations.to_string(),
    );
    html_metric(
        &mut out,
        "Checks",
        &format!(
            "{} passed / {} failed",
            report.totals.checks_passed, report.totals.checks_failed
        ),
    );
    html_metric(
        &mut out,
        "Changes",
        &format!(
            "{} files · +{} −{}",
            report.totals.files_changed, report.totals.additions, report.totals.deletions
        ),
    );
    out.push_str("</section>\n<section><h2>Objective</h2><p>");
    out.push_str(&html_multiline(&report.objective));
    out.push_str("</p>");
    if let Some(reference) = &report.reference {
        write!(
            out,
            "<p class=\"subtle\"><strong>Reference:</strong> {}</p>",
            html_text(reference)
        )
        .unwrap();
    }
    if !report.summary.is_empty() {
        write!(
            out,
            "<h3>Outcome</h3><p>{}</p>",
            html_multiline(&report.summary)
        )
        .unwrap();
    }
    out.push_str("<dl class=\"dates\">");
    html_date(&mut out, "Started", report.started_at_ms);
    html_date(&mut out, "Updated", report.updated_at_ms);
    if let Some(completed_at) = report.completed_at_ms {
        html_date(&mut out, "Completed", completed_at);
    }
    out.push_str("</dl></section>\n");

    if let Some(scores) = latest_scores(report) {
        out.push_str("<section><h2>Latest objective scores</h2><div class=\"table-wrap\"><table><thead><tr><th>Criterion</th><th>Score</th><th>Pass</th><th>Rationale</th></tr></thead><tbody>");
        for score in scores {
            write!(
                out,
                "<tr><td>{}</td><td>{}/{}</td><td>{}</td><td>{}</td></tr>",
                html_text(&score.criterion),
                score.score,
                score.maximum,
                score
                    .pass_threshold
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "—".into()),
                html_text(&score.rationale)
            )
            .unwrap();
        }
        out.push_str("</tbody></table></div></section>\n");
    }

    for iteration in &report.iterations {
        render_html_iteration(&mut out, iteration);
    }
    if !report.punch_list.is_empty() || !memory_is_empty(&report.next_iteration_memory) {
        out.push_str("<section><h2>Carry-forward</h2>");
        if !report.punch_list.is_empty() {
            render_html_punch_list(&mut out, &report.punch_list);
        }
        if !memory_is_empty(&report.next_iteration_memory) {
            render_html_memory(&mut out, &report.next_iteration_memory);
        }
        out.push_str("</section>\n");
    }
    out.push_str("</main>\n</body>\n</html>\n");
    out
}

fn render_markdown_iteration(out: &mut String, iteration: &IterationReport) {
    writeln!(out).unwrap();
    writeln!(
        out,
        "## Iteration {} — {}",
        iteration.iteration,
        iteration.outcome.label()
    )
    .unwrap();
    writeln!(out).unwrap();
    writeln!(
        out,
        "- Started: {}",
        format_timestamp_ms(iteration.started_at_ms)
    )
    .unwrap();
    writeln!(
        out,
        "- Completed: {}",
        format_timestamp_ms(iteration.completed_at_ms)
    )
    .unwrap();
    writeln!(
        out,
        "- Duration: {}",
        format_duration(iteration.duration_ms)
    )
    .unwrap();
    writeln!(out).unwrap();
    write_markdown_paragraph(out, &iteration.summary);

    if !iteration.agents.is_empty() {
        writeln!(out).unwrap();
        writeln!(out, "### Agents").unwrap();
        writeln!(out).unwrap();
        writeln!(out, "| Role | Agent | Result | Duration | Task |").unwrap();
        writeln!(out, "| --- | --- | --- | ---: | --- |").unwrap();
        for agent in &iteration.agents {
            writeln!(
                out,
                "| `{}` | {} | {} | {} | {} |",
                md_table(&agent.role),
                md_table(agent.agent_id.as_deref().unwrap_or("—")),
                agent.outcome.label(),
                format_duration(agent.duration_ms),
                md_table(&agent.task)
            )
            .unwrap();
            if !agent.summary.is_empty() {
                writeln!(out, "|  |  |  |  | {} |", md_table(&agent.summary)).unwrap();
            }
        }
    }
    if !iteration.checks.is_empty() {
        writeln!(out).unwrap();
        writeln!(out, "### Verification").unwrap();
        writeln!(out).unwrap();
        writeln!(out, "| Kind | Check | Result | Duration | Details |").unwrap();
        writeln!(out, "| --- | --- | --- | ---: | --- |").unwrap();
        for check in &iteration.checks {
            let mut details = check.details.clone();
            if let Some(command) = &check.command {
                if !details.is_empty() {
                    details.push_str(" — ");
                }
                details.push_str(command);
            }
            writeln!(
                out,
                "| {} | {} | {} | {} | {} |",
                check.kind.label(),
                md_table(&check.name),
                check.status.label(),
                format_duration(check.duration_ms),
                md_table(&details)
            )
            .unwrap();
        }
    }
    if !iteration.changed_files.is_empty() {
        writeln!(out).unwrap();
        writeln!(out, "### Changed files").unwrap();
        writeln!(out).unwrap();
        for file in &iteration.changed_files {
            writeln!(
                out,
                "- `{}` (+{} -{})",
                md_inline(&file.path),
                file.additions,
                file.deletions
            )
            .unwrap();
        }
    }
    if !iteration.evidence.is_empty() {
        writeln!(out).unwrap();
        writeln!(out, "### Evidence").unwrap();
        writeln!(out).unwrap();
        for evidence in &iteration.evidence {
            let caption = if evidence.caption.is_empty() {
                evidence.kind.label()
            } else {
                &evidence.caption
            };
            let embed = if is_inline_image(&evidence.path) {
                "!"
            } else {
                ""
            };
            writeln!(
                out,
                "- {}[{}]({}) — {}",
                embed,
                md_inline(caption),
                md_link_destination(&evidence.path),
                evidence.kind.label()
            )
            .unwrap();
        }
    }
    if !iteration.scores.is_empty() {
        writeln!(out).unwrap();
        writeln!(out, "### Objective scores").unwrap();
        writeln!(out).unwrap();
        for score in &iteration.scores {
            let pass = score
                .pass_threshold
                .map(|threshold| format!(", pass {threshold}"))
                .unwrap_or_default();
            writeln!(
                out,
                "- **{}:** {}/{}{} — {}",
                md_inline(&score.criterion),
                score.score,
                score.maximum,
                pass,
                md_inline(&score.rationale)
            )
            .unwrap();
        }
    }
    if !iteration.punch_list.is_empty() {
        render_markdown_punch_list(out, "Punch list", &iteration.punch_list);
    }
    if !memory_is_empty(&iteration.next_iteration_memory) {
        render_markdown_memory(
            out,
            "Next-iteration memory",
            &iteration.next_iteration_memory,
        );
    }
}

fn render_markdown_punch_list(out: &mut String, heading: &str, items: &[PunchItem]) {
    writeln!(out).unwrap();
    writeln!(out, "### {heading}").unwrap();
    writeln!(out).unwrap();
    for item in items {
        let mark = if item.resolved { "x" } else { " " };
        let source = item
            .source
            .as_ref()
            .map(|source| format!(" — {}", md_inline(source)))
            .unwrap_or_default();
        writeln!(
            out,
            "- [{mark}] **{}:** {}{}",
            item.priority.label(),
            md_inline(&item.item),
            source
        )
        .unwrap();
    }
}

fn render_markdown_memory(out: &mut String, heading: &str, memory: &NextIterationMemory) {
    writeln!(out).unwrap();
    writeln!(out, "### {heading}").unwrap();
    render_markdown_memory_group(out, "Observations", &memory.observations);
    render_markdown_memory_group(out, "Decisions", &memory.decisions);
    render_markdown_memory_group(out, "Risks", &memory.risks);
    render_markdown_memory_group(out, "Next actions", &memory.next_actions);
}

fn render_markdown_memory_group(out: &mut String, label: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    writeln!(out).unwrap();
    writeln!(out, "**{label}**").unwrap();
    writeln!(out).unwrap();
    for value in values {
        writeln!(out, "- {}", md_inline(value)).unwrap();
    }
}

fn render_html_iteration(out: &mut String, iteration: &IterationReport) {
    writeln!(
        out,
        "<article class=\"iteration\"><header><div><p class=\"eyebrow\">Iteration {}</p><h2>{}</h2></div><span class=\"badge {}\">{}</span></header>",
        iteration.iteration,
        format_duration(iteration.duration_ms),
        iteration.outcome.css_class(),
        iteration.outcome.label()
    )
    .unwrap();
    writeln!(
        out,
        "<p>{}</p><p class=\"subtle\">{} → {}</p>",
        html_multiline(&iteration.summary),
        format_timestamp_ms(iteration.started_at_ms),
        format_timestamp_ms(iteration.completed_at_ms)
    )
    .unwrap();
    if !iteration.agents.is_empty() {
        out.push_str("<h3>Agents</h3><div class=\"table-wrap\"><table><thead><tr><th>Role</th><th>Agent</th><th>Result</th><th>Duration</th><th>Task</th></tr></thead><tbody>");
        for agent in &iteration.agents {
            write!(
                out,
                "<tr><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td>{}<span class=\"detail\">{}</span></td></tr>",
                html_text(&agent.role),
                html_text(agent.agent_id.as_deref().unwrap_or("—")),
                agent.outcome.label(),
                format_duration(agent.duration_ms),
                html_text(&agent.task),
                html_text(&agent.summary)
            )
            .unwrap();
        }
        out.push_str("</tbody></table></div>");
    }
    if !iteration.checks.is_empty() {
        out.push_str("<h3>Verification</h3><div class=\"table-wrap\"><table><thead><tr><th>Kind</th><th>Check</th><th>Result</th><th>Duration</th><th>Details</th></tr></thead><tbody>");
        for check in &iteration.checks {
            write!(
                out,
                "<tr><td>{}</td><td>{}</td><td><span class=\"badge {}\">{}</span></td><td>{}</td><td>{}",
                check.kind.label(),
                html_text(&check.name),
                check.status.css_class(),
                check.status.label(),
                format_duration(check.duration_ms),
                html_text(&check.details)
            )
            .unwrap();
            if let Some(command) = &check.command {
                write!(out, "<code class=\"command\">{}</code>", html_text(command)).unwrap();
            }
            out.push_str("</td></tr>");
        }
        out.push_str("</tbody></table></div>");
    }
    if !iteration.changed_files.is_empty() {
        out.push_str("<h3>Changed files</h3><ul class=\"files\">");
        for file in &iteration.changed_files {
            write!(
                out,
                "<li><code>{}</code><span><ins>+{}</ins> <del>−{}</del></span></li>",
                html_text(&file.path),
                file.additions,
                file.deletions
            )
            .unwrap();
        }
        out.push_str("</ul>");
    }
    if !iteration.evidence.is_empty() {
        out.push_str("<h3>Evidence</h3><ul class=\"evidence\">");
        for evidence in &iteration.evidence {
            let caption = if evidence.caption.is_empty() {
                evidence.kind.label()
            } else {
                &evidence.caption
            };
            let href = html_attr(&evidence_url(&evidence.path));
            let caption_text = html_text(caption);
            let kind_label = evidence.kind.label();
            if is_inline_image(&evidence.path) {
                write!(
                    out,
                    "<li class=\"media\"><figure><a href=\"{href}\"><img src=\"{href}\" alt=\"{caption_text}\" loading=\"lazy\"></a><figcaption>{caption_text}<span>{kind_label}</span></figcaption></figure></li>"
                )
                .unwrap();
            } else if is_inline_video(&evidence.path) {
                write!(
                    out,
                    "<li class=\"media\"><figure><video src=\"{href}\" controls preload=\"metadata\"></video><figcaption>{caption_text}<span>{kind_label}</span></figcaption></figure></li>"
                )
                .unwrap();
            } else {
                write!(
                    out,
                    "<li><a href=\"{href}\">{caption_text}</a><span>{kind_label}</span></li>"
                )
                .unwrap();
            }
        }
        out.push_str("</ul>");
    }
    if !iteration.scores.is_empty() {
        out.push_str("<h3>Objective scores</h3><div class=\"score-grid\">");
        for score in &iteration.scores {
            write!(
                out,
                "<div><strong>{}</strong><span>{}/{}</span><p>{}</p></div>",
                html_text(&score.criterion),
                score.score,
                score.maximum,
                html_text(&score.rationale)
            )
            .unwrap();
        }
        out.push_str("</div>");
    }
    if !iteration.punch_list.is_empty() {
        out.push_str("<h3>Punch list</h3>");
        render_html_punch_list(out, &iteration.punch_list);
    }
    if !memory_is_empty(&iteration.next_iteration_memory) {
        out.push_str("<h3>Next-iteration memory</h3>");
        render_html_memory(out, &iteration.next_iteration_memory);
    }
    out.push_str("</article>\n");
}

fn render_html_punch_list(out: &mut String, items: &[PunchItem]) {
    out.push_str("<ul class=\"punch-list\">");
    for item in items {
        write!(
            out,
            "<li class=\"{}\"><span>{}</span><strong>{}</strong><p>{}</p></li>",
            if item.resolved { "resolved" } else { "open" },
            if item.resolved { "✓" } else { "○" },
            item.priority.label(),
            html_text(&item.item)
        )
        .unwrap();
    }
    out.push_str("</ul>");
}

fn render_html_memory(out: &mut String, memory: &NextIterationMemory) {
    out.push_str("<div class=\"memory-grid\">");
    render_html_memory_group(out, "Observations", &memory.observations);
    render_html_memory_group(out, "Decisions", &memory.decisions);
    render_html_memory_group(out, "Risks", &memory.risks);
    render_html_memory_group(out, "Next actions", &memory.next_actions);
    out.push_str("</div>");
}

fn render_html_memory_group(out: &mut String, label: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    write!(out, "<div><h4>{label}</h4><ul>").unwrap();
    for value in values {
        write!(out, "<li>{}</li>", html_text(value)).unwrap();
    }
    out.push_str("</ul></div>");
}

fn html_metric(out: &mut String, label: &str, value: &str) {
    writeln!(
        out,
        "<div><span>{}</span><strong>{}</strong></div>",
        html_text(label),
        html_text(value)
    )
    .unwrap();
}

fn html_date(out: &mut String, label: &str, timestamp_ms: u64) {
    let timestamp = format_timestamp_ms(timestamp_ms);
    write!(
        out,
        "<div><dt>{}</dt><dd><time datetime=\"{}\">{}</time></dd></div>",
        html_text(label),
        timestamp,
        timestamp
    )
    .unwrap();
}

fn validate_report(report: &LoopReport) -> Result<()> {
    if report.schema_version != LOOP_REPORT_SCHEMA_VERSION {
        anyhow::bail!(
            "unsupported loop report schemaVersion {}",
            report.schema_version
        );
    }
    crate::store::sanitize_slug(&report.project_slug)?;
    validate_component_id("loop id", &report.loop_id, MAX_LOOP_ID_LEN, true)?;
    validate_text("objective", &report.objective, MAX_OBJECTIVE_LEN, false)?;
    validate_optional_text("reference", report.reference.as_deref(), MAX_SHORT_TEXT_LEN)?;
    validate_text("summary", &report.summary, MAX_TEXT_LEN, true)?;
    if report.created_at_ms != report.started_at_ms {
        anyhow::bail!("createdAtMs must equal startedAtMs");
    }
    if report.updated_at_ms < report.started_at_ms {
        anyhow::bail!("updatedAtMs cannot precede startedAtMs");
    }
    match (report.status.is_terminal(), report.completed_at_ms) {
        (true, None) => anyhow::bail!("a terminal loop status requires completedAtMs"),
        (false, Some(_)) => anyhow::bail!("a running loop cannot have completedAtMs"),
        _ => {}
    }
    if let Some(completed_at) = report.completed_at_ms {
        if completed_at < report.started_at_ms {
            anyhow::bail!("completedAtMs cannot precede startedAtMs");
        }
        let last_iteration_end = report
            .iterations
            .iter()
            .map(|iteration| iteration.completed_at_ms)
            .max()
            .unwrap_or(report.started_at_ms);
        if completed_at < last_iteration_end {
            anyhow::bail!("completedAtMs cannot precede an iteration completion");
        }
    }
    if report.updated_at_ms
        < report
            .iterations
            .iter()
            .map(|iteration| iteration.completed_at_ms)
            .max()
            .unwrap_or(report.started_at_ms)
    {
        anyhow::bail!("updatedAtMs cannot precede an iteration completion");
    }
    if report.iterations.len() > MAX_ITERATIONS {
        anyhow::bail!("loop report exceeds the {MAX_ITERATIONS} iteration limit");
    }
    validate_punch_list(&report.punch_list)?;
    validate_memory(&report.next_iteration_memory)?;
    for (index, iteration) in report.iterations.iter().enumerate() {
        if iteration.iteration != index as u32 + 1 {
            anyhow::bail!("iteration numbers must be one-based and contiguous");
        }
        validate_iteration(iteration, report.started_at_ms)?;
    }
    let mut expected = report.clone();
    refresh_totals(&mut expected);
    if expected.totals != report.totals {
        anyhow::bail!("loop report totals do not match iteration data");
    }
    Ok(())
}

fn validate_iteration_input(input: &IterationInput, loop_started_at_ms: u64) -> Result<()> {
    let iteration = IterationReport {
        iteration: 1,
        started_at_ms: input.started_at_ms,
        completed_at_ms: input.completed_at_ms,
        duration_ms: input.completed_at_ms.saturating_sub(input.started_at_ms),
        outcome: input.outcome,
        summary: input.summary.clone(),
        agents: input.agents.clone(),
        checks: input.checks.clone(),
        changed_files: input.changed_files.clone(),
        evidence: input.evidence.clone(),
        scores: input.scores.clone(),
        punch_list: input.punch_list.clone(),
        next_iteration_memory: input.next_iteration_memory.clone(),
    };
    validate_iteration(&iteration, loop_started_at_ms)
}

fn validate_iteration(iteration: &IterationReport, loop_started_at_ms: u64) -> Result<()> {
    if iteration.started_at_ms < loop_started_at_ms {
        anyhow::bail!("iteration startedAtMs cannot precede the loop");
    }
    if iteration.completed_at_ms < iteration.started_at_ms {
        anyhow::bail!("iteration completedAtMs cannot precede startedAtMs");
    }
    if iteration.duration_ms != iteration.completed_at_ms - iteration.started_at_ms {
        anyhow::bail!("iteration durationMs does not match its timestamps");
    }
    validate_text("iteration summary", &iteration.summary, MAX_TEXT_LEN, false)?;
    for agent in &iteration.agents {
        validate_component_id("agent role", &agent.role, MAX_AGENT_ID_LEN, false)?;
        if let Some(agent_id) = &agent.agent_id {
            validate_component_id("agent id", agent_id, MAX_AGENT_ID_LEN, false)?;
        }
        validate_text("agent task", &agent.task, MAX_SHORT_TEXT_LEN, false)?;
        validate_text("agent summary", &agent.summary, MAX_TEXT_LEN, true)?;
    }
    for check in &iteration.checks {
        validate_text("check name", &check.name, MAX_SHORT_TEXT_LEN, false)?;
        validate_optional_text("check command", check.command.as_deref(), MAX_TEXT_LEN)?;
        validate_text("check details", &check.details, MAX_TEXT_LEN, true)?;
    }
    for file in &iteration.changed_files {
        validate_relative_path("changed file", &file.path)?;
    }
    for evidence in &iteration.evidence {
        validate_relative_path("evidence", &evidence.path)?;
        validate_text(
            "evidence caption",
            &evidence.caption,
            MAX_SHORT_TEXT_LEN,
            true,
        )?;
        if evidence
            .captured_at_ms
            .is_some_and(|captured| captured < loop_started_at_ms)
        {
            anyhow::bail!("evidence capturedAtMs cannot precede the loop");
        }
    }
    for score in &iteration.scores {
        validate_text(
            "score criterion",
            &score.criterion,
            MAX_SHORT_TEXT_LEN,
            false,
        )?;
        validate_text("score rationale", &score.rationale, MAX_TEXT_LEN, true)?;
        if score.maximum == 0 {
            anyhow::bail!("score maximum must be greater than zero");
        }
        if score.score > score.maximum {
            anyhow::bail!("score cannot exceed maximum");
        }
        if score
            .pass_threshold
            .is_some_and(|threshold| threshold > score.maximum)
        {
            anyhow::bail!("score passThreshold cannot exceed maximum");
        }
    }
    validate_punch_list(&iteration.punch_list)?;
    validate_memory(&iteration.next_iteration_memory)?;
    Ok(())
}

/// Gate that a loop has actually been driven to a provable completion. The
/// model may call `loop_report_update` before the client validates the run;
/// without this gate it can mark a single-iteration, evidence-less report
/// as `Completed` and the report looks finished on disk. Each check below
/// names a single concrete failure so the caller knows what to add.
fn validate_completion_readiness(report: &LoopReport) -> Result<()> {
    if report
        .reference
        .as_deref()
        .is_none_or(|reference| reference.trim().is_empty())
    {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: a named quality reference is required",
            loop_id = report.loop_id,
        );
    }
    if report.iterations.len() < COMPLETION_MIN_ITERATIONS {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: requires at least {required} iterations, found {found}",
            loop_id = report.loop_id,
            required = COMPLETION_MIN_ITERATIONS,
            found = report.iterations.len(),
        );
    }
    let last = report
        .iterations
        .last()
        .expect("checked iteration count above");
    if last.outcome != IterationOutcome::Passed {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: iteration {iteration} outcome is {actual}, must be passed",
            loop_id = report.loop_id,
            iteration = last.iteration,
            actual = last.outcome.label(),
        );
    }
    // Durable agent data: at least one agent run carries a non-empty
    // agent_id, so the work was attributed to a recorded orchestrator
    // session rather than a summary pasted from the client.
    let has_durable_agent = last.agents.iter().any(|agent| {
        agent
            .agent_id
            .as_deref()
            .is_some_and(|identifier| !identifier.is_empty())
    });
    if !has_durable_agent {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: iteration {iteration} has no agent run with a non-empty agent_id",
            loop_id = report.loop_id,
            iteration = last.iteration,
        );
    }
    // Build, play, and test must each have at least one passing check. A
    // single "build passed" with no play/test trace is not a loop completion.
    for kind in [CheckKind::Build, CheckKind::Play, CheckKind::Test] {
        let passed = last
            .checks
            .iter()
            .any(|check| check.kind == kind && check.status == CheckStatus::Passed);
        if !passed {
            anyhow::bail!(
                "cannot mark loop {loop_id} completed: iteration {iteration} has no passing {kind} check",
                loop_id = report.loop_id,
                iteration = last.iteration,
                kind = kind.label(),
            );
        }
    }
    if last
        .checks
        .iter()
        .any(|check| check.status == CheckStatus::Failed)
    {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: iteration {iteration} still contains a failed check",
            loop_id = report.loop_id,
            iteration = last.iteration,
        );
    }
    let has_visual_evidence = last.evidence.iter().any(|evidence| {
        matches!(
            evidence.kind,
            EvidenceKind::Screenshot | EvidenceKind::Video | EvidenceKind::ContactSheet
        )
    });
    if !has_visual_evidence {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: iteration {iteration} has no visual evidence (screenshot, video, or contact sheet)",
            loop_id = report.loop_id,
            iteration = last.iteration,
        );
    }
    if last.scores.is_empty() {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: iteration {iteration} has no objective scores",
            loop_id = report.loop_id,
            iteration = last.iteration,
        );
    }
    if let Some(score) = last.scores.iter().find(|score| {
        score
            .pass_threshold
            .is_some_and(|threshold| score.score < threshold)
    }) {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: score {criterion:?} is below its passThreshold",
            loop_id = report.loop_id,
            criterion = score.criterion,
        );
    }
    let average_percent = (last
        .scores
        .iter()
        .map(|score| f64::from(score.score) * 100.0 / f64::from(score.maximum))
        .sum::<f64>()
        / last.scores.len() as f64)
        .floor() as u32;
    if average_percent < COMPLETION_DEFAULT_SCORE_THRESHOLD {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: iteration {iteration} average score is {average_percent}, below {required}",
            loop_id = report.loop_id,
            iteration = last.iteration,
            required = COMPLETION_DEFAULT_SCORE_THRESHOLD,
        );
    }
    if !report
        .iterations
        .iter()
        .any(|iteration| !iteration.changed_files.is_empty())
    {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: no iteration records changed files",
            loop_id = report.loop_id,
        );
    }
    // Structured memory: the final iteration must leave observations,
    // decisions, risks, or next actions behind. An empty memory is the
    // signature of the AgentPanel's generic fallback payload.
    let memory = &last.next_iteration_memory;
    let memory_count = memory.observations.len()
        + memory.decisions.len()
        + memory.risks.len()
        + memory.next_actions.len();
    if memory_count == 0 {
        anyhow::bail!(
            "cannot mark loop {loop_id} completed: iteration {iteration} nextIterationMemory is empty (observations, decisions, risks, or nextActions required)",
            loop_id = report.loop_id,
            iteration = last.iteration,
        );
    }
    Ok(())
}

fn validate_punch_list(items: &[PunchItem]) -> Result<()> {
    for item in items {
        validate_text("punch-list item", &item.item, MAX_SHORT_TEXT_LEN, false)?;
        validate_optional_text(
            "punch-list source",
            item.source.as_deref(),
            MAX_SHORT_TEXT_LEN,
        )?;
    }
    Ok(())
}

fn validate_memory(memory: &NextIterationMemory) -> Result<()> {
    for (label, values) in [
        ("memory observation", &memory.observations),
        ("memory decision", &memory.decisions),
        ("memory risk", &memory.risks),
        ("memory next action", &memory.next_actions),
    ] {
        for value in values {
            validate_text(label, value, MAX_SHORT_TEXT_LEN, false)?;
        }
    }
    Ok(())
}

fn validate_component_id(label: &str, value: &str, max_len: usize, lowercase: bool) -> Result<()> {
    if value.is_empty() {
        anyhow::bail!("invalid {label}: empty");
    }
    if value.len() > max_len {
        anyhow::bail!("invalid {label}: longer than {max_len} characters");
    }
    if !value.chars().all(|character| {
        character.is_ascii_lowercase()
            || (!lowercase && character.is_ascii_uppercase())
            || character.is_ascii_digit()
            || character == '-'
            || character == '_'
    }) {
        let case = if lowercase { "lowercase " } else { "" };
        anyhow::bail!("invalid {label}: use {case}ASCII letters, digits, '-' and '_' only");
    }
    Ok(())
}

fn validate_relative_path(label: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        anyhow::bail!("invalid {label} path: empty");
    }
    if value.len() > MAX_PATH_LEN {
        anyhow::bail!("invalid {label} path: longer than {MAX_PATH_LEN} characters");
    }
    if value.contains('\\')
        || value.contains(':')
        || value.contains('?')
        || value.contains('#')
        || value.chars().any(char::is_control)
    {
        anyhow::bail!("invalid {label} path: contains an unsafe character");
    }
    let path = Path::new(value);
    if path.is_absolute() {
        anyhow::bail!("invalid {label} path: must be relative");
    }
    let mut components = 0;
    for component in path.components() {
        match component {
            Component::Normal(_) => components += 1,
            _ => anyhow::bail!("invalid {label} path: traversal is not allowed"),
        }
    }
    if components == 0 || components > MAX_PATH_COMPONENTS {
        anyhow::bail!("invalid {label} path: invalid component count");
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, max_len: usize, allow_empty: bool) -> Result<()> {
    if !allow_empty && value.trim().is_empty() {
        anyhow::bail!("{label} cannot be empty");
    }
    if value.len() > max_len {
        anyhow::bail!("{label} exceeds the {max_len}-byte limit");
    }
    if value.chars().any(|character| character == '\0') {
        anyhow::bail!("{label} contains a NUL character");
    }
    Ok(())
}

fn validate_optional_text(label: &str, value: Option<&str>, max_len: usize) -> Result<()> {
    if let Some(value) = value {
        validate_text(label, value, max_len, false)?;
    }
    Ok(())
}

fn refresh_totals(report: &mut LoopReport) {
    let mut totals = LoopTotals::default();
    let mut files = BTreeSet::new();
    totals.iterations = report.iterations.len() as u32;
    for iteration in &report.iterations {
        totals.worked_duration_ms = totals
            .worked_duration_ms
            .saturating_add(iteration.duration_ms);
        totals.agents = totals.agents.saturating_add(iteration.agents.len() as u32);
        for check in &iteration.checks {
            match check.status {
                CheckStatus::Passed => {
                    totals.checks_passed = totals.checks_passed.saturating_add(1)
                }
                CheckStatus::Failed => {
                    totals.checks_failed = totals.checks_failed.saturating_add(1)
                }
                CheckStatus::Skipped => {
                    totals.checks_skipped = totals.checks_skipped.saturating_add(1)
                }
            }
        }
        for file in &iteration.changed_files {
            files.insert(file.path.clone());
            totals.additions = totals.additions.saturating_add(file.additions);
            totals.deletions = totals.deletions.saturating_add(file.deletions);
        }
    }
    totals.files_changed = files.len() as u32;
    totals.elapsed_duration_ms = report
        .completed_at_ms
        .unwrap_or(report.updated_at_ms)
        .saturating_sub(report.started_at_ms);
    totals.latest_score_percent = report
        .iterations
        .iter()
        .rev()
        .find(|iteration| !iteration.scores.is_empty())
        .map(|iteration| {
            let sum: u64 = iteration
                .scores
                .iter()
                .map(|score| u64::from(score.score) * 100 / u64::from(score.maximum.max(1)))
                .sum();
            (sum / iteration.scores.len() as u64) as u32
        });
    report.totals = totals;
}

fn latest_scores(report: &LoopReport) -> Option<Vec<&ObjectiveScore>> {
    let mut scores = BTreeMap::<&str, &ObjectiveScore>::new();
    for iteration in &report.iterations {
        for score in &iteration.scores {
            scores.insert(&score.criterion, score);
        }
    }
    (!scores.is_empty()).then(|| scores.into_values().collect())
}

fn memory_is_empty(memory: &NextIterationMemory) -> bool {
    memory.observations.is_empty()
        && memory.decisions.is_empty()
        && memory.risks.is_empty()
        && memory.next_actions.is_empty()
}

fn ensure_project_exists(projects_root: &Path, project_slug: &str) -> Result<()> {
    let project_file = crate::store::project_file(projects_root, project_slug)?;
    if !project_file.is_file() {
        anyhow::bail!("project {project_slug} not found");
    }
    Ok(())
}

fn io_guard() -> Result<MutexGuard<'static, ()>> {
    REPORT_IO_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("loop report I/O lock is poisoned"))
}

fn read_report_unlocked(
    paths: &ReportPaths,
    project_slug: &str,
    loop_id: &str,
) -> Result<LoopReport> {
    let bytes = std::fs::read(&paths.json)
        .with_context(|| format!("loop report {loop_id} not found for project {project_slug}"))?;
    let report: LoopReport = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid loop report {}", paths.json.display()))?;
    validate_report(&report)?;
    if report.project_slug != project_slug || report.loop_id != loop_id {
        anyhow::bail!("loop report identity does not match its path");
    }
    Ok(report)
}

fn write_bundle_atomic(paths: &ReportPaths, report: &LoopReport) -> Result<()> {
    std::fs::create_dir_all(&paths.directory)?;
    let mut json = serde_json::to_vec_pretty(report)?;
    json.push(b'\n');
    let markdown = render_markdown(report);
    let html = render_html(report);
    let token = Uuid::new_v4().simple().to_string();
    let temp_json = temp_sibling(&paths.json, &token)?;
    let temp_markdown = temp_sibling(&paths.markdown, &token)?;
    let temp_html = temp_sibling(&paths.html, &token)?;
    let temps = [&temp_json, &temp_markdown, &temp_html];

    let result = (|| -> Result<()> {
        write_synced(&temp_json, &json)?;
        write_synced(&temp_markdown, markdown.as_bytes())?;
        write_synced(&temp_html, html.as_bytes())?;
        // JSON is the commit marker. A crash before its rename leaves the old
        // source of truth valid; Markdown/HTML are regenerated next mutation.
        std::fs::rename(&temp_markdown, &paths.markdown)?;
        std::fs::rename(&temp_html, &paths.html)?;
        std::fs::rename(&temp_json, &paths.json)?;
        if let Ok(directory) = File::open(&paths.directory) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        for temp in temps {
            let _ = std::fs::remove_file(temp);
        }
    }
    result
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn temp_sibling(path: &Path, token: &str) -> Result<PathBuf> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("loop report path has no UTF-8 file name")?;
    Ok(path.with_file_name(format!(".{name}.{token}.tmp")))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn format_duration(duration_ms: u64) -> String {
    let total_seconds = duration_ms / 1_000;
    let hours = total_seconds / 3_600;
    let minutes = total_seconds % 3_600 / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes:02}m {seconds:02}s")
    } else if minutes > 0 {
        format!("{minutes}m {seconds:02}s")
    } else if total_seconds > 0 {
        format!("{seconds}s")
    } else {
        format!("{duration_ms}ms")
    }
}

fn plural(count: u32) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

// Howard Hinnant's civil_from_days algorithm, avoiding a date dependency for
// the one UTC representation used by report renderers.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn format_timestamp_ms(timestamp_ms: u64) -> String {
    let seconds = (timestamp_ms / 1_000).min(i64::MAX as u64) as i64;
    let millis = timestamp_ms % 1_000;
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        second_of_day / 3_600,
        second_of_day % 3_600 / 60,
        second_of_day % 60
    )
}

fn write_markdown_paragraph(out: &mut String, text: &str) {
    for (index, line) in text.lines().enumerate() {
        if index > 0 {
            writeln!(out).unwrap();
        }
        write!(out, "{}", md_inline(line)).unwrap();
    }
    writeln!(out).unwrap();
}

fn md_inline(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '#' | '|' => {
                out.push('\\');
                out.push(character);
            }
            '\r' | '\n' => out.push(' '),
            _ => out.push(character),
        }
    }
    out
}

fn md_table(value: &str) -> String {
    md_inline(value).replace(['\n', '\r'], " ")
}

fn md_link_destination(value: &str) -> String {
    evidence_url(value)
}

/// `report.html` and `report.md` are written to
/// `<project>/reports/loops/<loop-id>/`, but evidence paths are recorded
/// project-relative. Without this hop up, every link resolves inside the loop
/// directory and 404s.
const EVIDENCE_URL_PREFIX: &str = "../../../";

/// Percent-encoded link to project-relative evidence, usable from a report
/// document. Absolute paths and URLs are already self-locating and pass through.
fn evidence_url(value: &str) -> String {
    // Percent-encoding an absolute URL would destroy its scheme separator;
    // escaping for the surrounding attribute happens at the call site.
    if value.contains("://") {
        return value.to_string();
    }
    let encoded = relative_url(value);
    if value.starts_with('/') {
        encoded
    } else {
        format!("{EVIDENCE_URL_PREFIX}{encoded}")
    }
}

fn has_extension(value: &str, extensions: &[&str]) -> bool {
    let tail = value
        .rsplit('/')
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    extensions.iter().any(|ext| tail.ends_with(ext))
}

/// Only inline media the browser can actually decode; anything else stays a
/// plain link rather than rendering as a broken image.
fn is_inline_image(value: &str) -> bool {
    has_extension(value, &[".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"])
}

fn is_inline_video(value: &str) -> bool {
    has_extension(value, &[".mp4", ".webm", ".mov"])
}

fn relative_url(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    out
}

fn html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn html_attr(value: &str) -> String {
    html_text(value)
}

fn html_multiline(value: &str) -> String {
    html_text(value)
        .replace("\r\n", "<br>")
        .replace(['\r', '\n'], "<br>")
}

const HTML_STYLE: &str = r#":root {
  color-scheme: light dark;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --surface: light-dark(#f5f5f3, #171816);
  --panel: light-dark(#ffffff, #21221f);
  --ink: light-dark(#191a18, #f1f2ef);
  --subtle: light-dark(#6b6e68, #a9ada5);
  --line: light-dark(#dedfd9, #373a34);
  --accent: light-dark(#2e6548, #82c69f);
  --danger: light-dark(#a23b34, #ef8e86);
  --warning: light-dark(#85600b, #e5bd5c);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); line-height: 1.55; }
main { width: min(1120px, calc(100% - 32px)); margin: 32px auto 72px; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
h1, h2, h3, h4, p { margin-top: 0; }
h1 { margin-bottom: 4px; font-size: clamp(30px, 5vw, 54px); letter-spacing: -.04em; }
h2 { letter-spacing: -.02em; }
h3 { margin-top: 28px; }
.eyebrow { margin-bottom: 4px; color: var(--subtle); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.badge { display: inline-flex; align-items: center; width: fit-content; border-radius: 999px; padding: 4px 9px; background: var(--surface); color: var(--subtle); font-size: 12px; font-weight: 700; white-space: nowrap; }
.badge.running, .badge.passed { color: var(--accent); }
.badge.failed { color: var(--danger); }
.badge.warning { color: var(--warning); }
section, article { margin-top: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); padding: clamp(18px, 3vw, 30px); }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; padding: 0; overflow: hidden; background: var(--line); }
.summary-grid > div { min-height: 104px; background: var(--panel); padding: 20px; }
.summary-grid span, .detail, .subtle { color: var(--subtle); }
.summary-grid strong { display: block; margin-top: 8px; font-size: 20px; }
.dates { display: flex; flex-wrap: wrap; gap: 12px 28px; margin: 24px 0 0; }
.dates div { display: flex; gap: 8px; }
.dates dt { color: var(--subtle); }
.dates dd { margin: 0; font-variant-numeric: tabular-nums; }
.iteration > header h2 { margin-bottom: 0; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
th { color: var(--subtle); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
.detail, .command { display: block; margin-top: 5px; }
.files, .evidence, .punch-list { list-style: none; margin: 0; padding: 0; }
.files li, .evidence li { display: flex; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--line); padding: 9px 0; }
.evidence li.media { display: block; }
.evidence figure { margin: 0; }
/* Cap rather than stretch: a small capture upscaled to the column width just
   renders as blur, and contact sheets are already wide. */
.evidence figure img, .evidence figure video { display: block; max-width: min(100%, 720px); height: auto; border: 1px solid var(--line); border-radius: 6px; background: #0d1117; }
.evidence figcaption { display: flex; justify-content: space-between; gap: 18px; padding: 7px 0 0; }
ins { color: var(--accent); text-decoration: none; }
del { color: var(--danger); text-decoration: none; }
a { color: var(--accent); text-underline-offset: 3px; }
.score-grid, .memory-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.score-grid > div, .memory-grid > div { border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
.score-grid strong, .score-grid span { display: block; }
.score-grid span { margin: 4px 0; font-size: 24px; font-weight: 700; }
.score-grid p { margin-bottom: 0; color: var(--subtle); }
.punch-list li { display: grid; grid-template-columns: auto 90px 1fr; gap: 10px; border-bottom: 1px solid var(--line); padding: 9px 0; }
.punch-list p { margin: 0; }
.punch-list .resolved { color: var(--subtle); }
@media (max-width: 760px) {
  .summary-grid, .score-grid, .memory-grid { grid-template-columns: 1fr 1fr; }
  .punch-list li { grid-template-columns: auto 1fr; }
  .punch-list p { grid-column: 2; }
}
@media (max-width: 480px) {
  main { width: min(100% - 20px, 1120px); margin-top: 18px; }
  .summary-grid, .score-grid, .memory-grid { grid-template-columns: 1fr; }
}"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const START: u64 = 1_786_406_400_000;

    fn project_root() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("space-game")).unwrap();
        std::fs::write(root.path().join("space-game/project.json"), "{}").unwrap();
        let path = root.path().to_path_buf();
        (root, path)
    }

    fn sample_input(offset_ms: u64, summary: &str) -> IterationInput {
        IterationInput {
            started_at_ms: START + offset_ms,
            completed_at_ms: START + offset_ms + 65_432,
            outcome: IterationOutcome::NeedsWork,
            summary: summary.into(),
            agents: vec![AgentRun {
                role: "gameplay-engineer".into(),
                agent_id: Some("agent-01".into()),
                task: "Build the encounter loop".into(),
                outcome: AgentOutcome::Passed,
                summary: "Movement and combat are wired.".into(),
                duration_ms: 60_000,
            }],
            checks: vec![
                CheckResult {
                    kind: CheckKind::Build,
                    name: "Production build".into(),
                    command: Some("pnpm build".into()),
                    status: CheckStatus::Passed,
                    duration_ms: 4_200,
                    details: "No warnings".into(),
                },
                CheckResult {
                    kind: CheckKind::Play,
                    name: "Boss arena input".into(),
                    command: None,
                    status: CheckStatus::Failed,
                    duration_ms: 8_000,
                    details: "Dodge timing is unclear".into(),
                },
            ],
            changed_files: vec![
                ChangedFile {
                    path: "scripts/player.ts".into(),
                    additions: 41,
                    deletions: 7,
                },
                ChangedFile {
                    path: "project.json".into(),
                    additions: 6,
                    deletions: 2,
                },
            ],
            evidence: vec![
                Evidence {
                    kind: EvidenceKind::Screenshot,
                    path: "evidence/frame 001.png".into(),
                    caption: "Arena after the first wave".into(),
                    captured_at_ms: Some(START + offset_ms + 30_000),
                },
                Evidence {
                    kind: EvidenceKind::Video,
                    path: "evidence/playthrough.mp4".into(),
                    caption: "Full playthrough".into(),
                    captured_at_ms: Some(START + offset_ms + 60_000),
                },
            ],
            scores: vec![ObjectiveScore {
                criterion: "Combat readability".into(),
                score: 82,
                maximum: 100,
                pass_threshold: Some(90),
                rationale: "Telegraphs need another pass.".into(),
            }],
            punch_list: vec![PunchItem {
                priority: PunchPriority::High,
                item: "Increase the dodge telegraph window".into(),
                source: Some("visual-critic".into()),
                resolved: false,
            }],
            next_iteration_memory: NextIterationMemory {
                observations: vec!["Players miss the amber wind-up.".into()],
                decisions: vec!["Keep the arena layout.".into()],
                risks: vec!["More particles could hurt frame time.".into()],
                next_actions: vec!["Tune the dodge cue, then replay.".into()],
            },
        }
    }

    /// IterationInput that clears the completion-readiness gate. Mirrors
    /// `sample_input` but flips every requirement: passed outcome, durable
    /// agent data, every build/play/test check passing, changed files, a
    /// score at the default 90 threshold, and structured iteration memory.
    fn passing_input(offset_ms: u64, summary: &str) -> IterationInput {
        let mut input = sample_input(offset_ms, summary);
        input.outcome = IterationOutcome::Passed;
        // sample_input ships a failing Play check; flip it to passed and
        // add a Test check so every gate kind has a passing row.
        for check in &mut input.checks {
            if matches!(
                check.kind,
                CheckKind::Build | CheckKind::Play | CheckKind::Test
            ) {
                check.status = CheckStatus::Passed;
            }
        }
        input.checks.push(CheckResult {
            kind: CheckKind::Test,
            name: "Smoke".into(),
            command: Some("pnpm test".into()),
            status: CheckStatus::Passed,
            duration_ms: 1_500,
            details: "All green".into(),
        });
        // Bump the only score to clear the default 90 threshold without
        // relying on an explicit passThreshold override.
        if let Some(score) = input.scores.first_mut() {
            score.score = 90;
            score.pass_threshold = None;
            score.rationale = "Telegraphs are clear and timing reads.".into();
        }
        input
    }

    fn create_sample(root: &Path) -> LoopReport {
        create(
            root,
            "space-game",
            "aaa-pass-01",
            NewLoopReport {
                objective: "Build a polished arena loop".into(),
                reference: Some("DOOM Eternal arena pacing".into()),
                started_at_ms: START,
            },
        )
        .unwrap()
    }

    #[test]
    fn creates_appends_loads_and_renders_all_evidence() {
        let (_temp, root) = project_root();
        create_sample(&root);
        let report = append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            sample_input(1_000, "The core loop works; telegraphs need polish."),
        )
        .unwrap();

        assert_eq!(report.totals.iterations, 1);
        assert_eq!(report.totals.worked_duration_ms, 65_432);
        assert_eq!(report.totals.files_changed, 2);
        assert_eq!(report.totals.additions, 47);
        assert_eq!(report.totals.deletions, 9);
        assert_eq!(report.totals.checks_passed, 1);
        assert_eq!(report.totals.checks_failed, 1);
        assert_eq!(report.totals.latest_score_percent, Some(82));
        assert_eq!(load(&root, "space-game", "aaa-pass-01").unwrap(), report);

        let paths = report_paths(&root, "space-game", "aaa-pass-01").unwrap();
        let markdown = std::fs::read_to_string(paths.markdown).unwrap();
        let html = std::fs::read_to_string(paths.html).unwrap();
        assert!(markdown.contains("## Iteration 1 — Needs work"));
        assert!(
            markdown.contains("![Arena after the first wave](../../../evidence/frame%20001.png)")
        );
        // Non-image evidence stays a plain link rather than a broken embed.
        assert!(markdown.contains("[Full playthrough](../../../evidence/playthrough.mp4)"));
        assert!(markdown.contains("scripts/player.ts` (+41 -7)"));
        assert!(markdown.contains("Next-iteration memory"));
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("../../../evidence/frame%20001.png"));
        assert!(html.contains("<img src=\"../../../evidence/frame%20001.png\""));
        assert!(html.contains("<video src=\"../../../evidence/playthrough.mp4\""));
        assert!(html.contains("Combat readability"));
        assert!(html.contains("Tune the dodge cue, then replay."));
    }

    #[test]
    fn evidence_urls_climb_out_of_the_loop_report_directory() {
        // report.html lives at <project>/reports/loops/<loop-id>/, so a
        // project-relative capture must hop up three levels to resolve.
        assert_eq!(
            evidence_url("reports/video/sheet.png"),
            "../../../reports/video/sheet.png"
        );
        // Already-self-locating destinations are left alone.
        assert_eq!(evidence_url("/tmp/frame.png"), "/tmp/frame.png");
        assert_eq!(
            evidence_url("https://example.com/a.png"),
            "https://example.com/a.png"
        );
    }

    #[test]
    fn inline_media_detection_is_extension_and_case_insensitive() {
        assert!(is_inline_image("reports/video/Sheet.PNG"));
        assert!(is_inline_image("a/b/frame.jpeg"));
        assert!(!is_inline_image("reports/trace.json"));
        // A directory that looks like an image must not fool the check.
        assert!(!is_inline_image("weird.png/trace.json"));
        assert!(is_inline_video("clips/run.mp4"));
        assert!(!is_inline_video("clips/run.png"));
    }

    #[test]
    fn starting_the_same_running_report_is_idempotent() {
        let (_temp, root) = project_root();
        let first = create_sample(&root);
        let resumed = create(
            &root,
            "space-game",
            "aaa-pass-01",
            NewLoopReport {
                objective: first.objective.clone(),
                reference: first.reference.clone(),
                started_at_ms: first.started_at_ms + 99_000,
            },
        )
        .unwrap();
        assert_eq!(resumed, first);

        let same_owner_retry = create(
            &root,
            "space-game",
            "aaa-pass-01",
            NewLoopReport {
                objective: "different objective".into(),
                reference: None,
                started_at_ms: first.started_at_ms,
            },
        )
        .unwrap();
        assert_eq!(same_owner_retry, first);
        assert_eq!(same_owner_retry.objective, first.objective);
    }

    #[test]
    fn lists_report_summaries_newest_first_and_handles_an_empty_project() {
        let (_temp, root) = project_root();
        assert!(list(&root, "space-game").unwrap().is_empty());
        create_sample(&root);
        create(
            &root,
            "space-game",
            "newer-loop",
            NewLoopReport {
                objective: "Polish the final encounter".into(),
                reference: None,
                started_at_ms: START + 200_000,
            },
        )
        .unwrap();
        let summaries = list(&root, "space-game").unwrap();
        assert_eq!(
            summaries
                .iter()
                .map(|report| report.loop_id.as_str())
                .collect::<Vec<_>>(),
            vec!["newer-loop", "aaa-pass-01"]
        );
        assert_eq!(summaries[0].objective, "Polish the final encounter");
        assert_eq!(summaries[0].status, LoopStatus::Running);
        assert_eq!(summaries[0].totals.iterations, 0);
    }

    #[test]
    fn terminal_update_is_atomic_and_requires_a_completion_time() {
        let (_temp, root) = project_root();
        create_sample(&root);
        // Seed two iterations that clear the completion-readiness gate:
        // passed outcome, durable agents, build/play/test checks, visual
        // evidence, score at or above the default 90 threshold, and a
        // structured nextIterationMemory.
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First pass"),
        )
        .unwrap();
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(90_000, "Second pass"),
        )
        .unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("requires completedAtMs"));

        let report = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                summary: Some("The quality threshold passed.".into()),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(report.status, LoopStatus::Completed);
        assert!(render_markdown(&report).contains("The quality threshold passed."));
        assert!(append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(300_000, "Too late")
        )
        .unwrap_err()
        .to_string()
        .contains("cannot append"));
    }

    #[test]
    fn rejects_traversal_unsafe_identifiers_and_unsafe_links() {
        let (_temp, root) = project_root();
        for loop_id in ["../escape", "UPPER", "has space", "x/y", ""] {
            assert!(create(
                &root,
                "space-game",
                loop_id,
                NewLoopReport {
                    objective: "Safe objective".into(),
                    reference: None,
                    started_at_ms: START,
                }
            )
            .is_err());
        }
        assert!(report_paths(&root, "../escape", "safe-loop").is_err());
        create_sample(&root);
        for path in [
            "../secret.png",
            "/tmp/secret.png",
            "javascript:alert(1)",
            "folder\\secret.png",
            "frame.png?download=1",
            "frame.png#anchor",
        ] {
            let mut input = sample_input(1_000, "Unsafe evidence");
            input.evidence[0].path = path.into();
            assert!(append_iteration(&root, "space-game", "aaa-pass-01", input).is_err());
        }
    }

    #[test]
    fn rejects_invalid_scores_timestamps_and_changed_file_paths() {
        let (_temp, root) = project_root();
        create_sample(&root);

        let mut input = sample_input(1_000, "Bad score");
        input.scores[0].score = 101;
        assert!(append_iteration(&root, "space-game", "aaa-pass-01", input).is_err());

        let mut input = sample_input(1_000, "Bad timestamp");
        input.completed_at_ms = input.started_at_ms - 1;
        assert!(append_iteration(&root, "space-game", "aaa-pass-01", input).is_err());

        let mut input = sample_input(1_000, "Before loop");
        input.started_at_ms = START - 1;
        input.completed_at_ms = START;
        assert!(append_iteration(&root, "space-game", "aaa-pass-01", input).is_err());

        let mut input = sample_input(1_000, "Bad file");
        input.changed_files[0].path = "scripts/../../secret".into();
        assert!(append_iteration(&root, "space-game", "aaa-pass-01", input).is_err());
    }

    #[test]
    fn concurrent_appends_keep_every_iteration_and_leave_no_temp_files() {
        let (_temp, root) = project_root();
        create_sample(&root);
        let root = Arc::new(root);
        let mut threads = Vec::new();
        for index in 0..16_u64 {
            let root = root.clone();
            threads.push(std::thread::spawn(move || {
                append_iteration(
                    &root,
                    "space-game",
                    "aaa-pass-01",
                    sample_input(1_000 + index * 100_000, &format!("Writer {index}")),
                )
                .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let report = load(&root, "space-game", "aaa-pass-01").unwrap();
        assert_eq!(report.iterations.len(), 16);
        assert_eq!(
            report
                .iterations
                .iter()
                .map(|iteration| iteration.iteration)
                .collect::<Vec<_>>(),
            (1..=16).collect::<Vec<_>>()
        );
        let summaries = report
            .iterations
            .iter()
            .map(|iteration| iteration.summary.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(summaries.len(), 16);
        let paths = report_paths(&root, "space-game", "aaa-pass-01").unwrap();
        assert!(std::fs::read_dir(paths.directory)
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
    }

    #[test]
    fn renderers_are_deterministic_and_escape_untrusted_text() {
        let (_temp, root) = project_root();
        create(
            &root,
            "space-game",
            "escaped-report",
            NewLoopReport {
                objective: "<script>alert('x')</script> | **markdown**".into(),
                reference: None,
                started_at_ms: 0,
            },
        )
        .unwrap();
        let report = load(&root, "space-game", "escaped-report").unwrap();
        let markdown = render_markdown(&report);
        let html = render_html(&report);
        assert_eq!(markdown, render_markdown(&report));
        assert_eq!(html, render_html(&report));
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("&lt;script&gt;alert"));
        assert!(markdown.contains("\\<script\\>"));
        assert_eq!(format_timestamp_ms(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn rejects_a_record_whose_identity_or_totals_were_tampered_with() {
        let (_temp, root) = project_root();
        create_sample(&root);
        let paths = report_paths(&root, "space-game", "aaa-pass-01").unwrap();
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&paths.json).unwrap()).unwrap();
        value["projectSlug"] = serde_json::json!("another-project");
        std::fs::write(&paths.json, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        assert!(load(&root, "space-game", "aaa-pass-01")
            .unwrap_err()
            .to_string()
            .contains("identity"));

        value["projectSlug"] = serde_json::json!("space-game");
        value["totals"]["additions"] = serde_json::json!(999);
        std::fs::write(&paths.json, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        assert!(load(&root, "space-game", "aaa-pass-01")
            .unwrap_err()
            .to_string()
            .contains("totals"));

        value["totals"]["additions"] = serde_json::json!(0);
        value["updatedAtMs"] = serde_json::json!(START - 1);
        std::fs::write(&paths.json, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        assert!(load(&root, "space-game", "aaa-pass-01")
            .unwrap_err()
            .to_string()
            .contains("updatedAtMs"));
    }

    /// Pin the schema/runtime contract the dispatch depends on. Live model
    /// calls have arrived in both camelCase (AgentPanel fallback) and
    /// snake_case (a strict coordinator guessing the field names), with
    /// minimal shapes that omit every optional collection. Deserialization
    /// must accept either naming convention so a successful iteration 1
    /// does not gate iteration 2 on the model's spelling.
    #[test]
    fn accepts_snake_case_and_minimal_iteration_inputs() {
        let (_temp, root) = project_root();
        create_sample(&root);

        let snake_minimal = serde_json::json!({
            "started_at_ms": START + 1_000,
            "completed_at_ms": START + 65_432,
            "outcome": "needs-work",
            "summary": "snake case iteration",
            "punch_list": [],
            "next_iteration_memory": {
                "observations": [],
                "decisions": [],
                "risks": [],
                "next_actions": []
            }
        });
        let parsed: IterationInput =
            serde_json::from_value(super::normalize_iteration_payload(snake_minimal))
                .expect("snake_case minimal iteration must deserialize after normalisation");
        assert_eq!(parsed.summary, "snake case iteration");
        assert!(append_iteration(&root, "space-game", "aaa-pass-01", parsed).is_ok());

        let camel_minimal = serde_json::json!({
            "startedAtMs": START + 200_000,
            "completedAtMs": START + 230_000,
            "outcome": "passed",
            "summary": "camel case iteration",
            "punchList": [],
            "nextIterationMemory": {
                "observations": [],
                "decisions": [],
                "risks": [],
                "nextActions": []
            }
        });
        let parsed: IterationInput =
            serde_json::from_value(super::normalize_iteration_payload(camel_minimal))
                .expect("camelCase minimal iteration must deserialize after normalisation");
        assert_eq!(parsed.summary, "camel case iteration");
        assert!(append_iteration(&root, "space-game", "aaa-pass-01", parsed).is_ok());
    }

    /// A model that omits every optional collection (an empty object) is the
    /// shape the live coordinator fell back to. The error must name the
    /// missing field so the model can self-correct instead of seeing a
    /// opaque "invalid loop iteration".
    #[test]
    fn empty_iteration_object_is_a_clear_payload_error() {
        let empty = serde_json::json!({});
        let error = serde_json::from_value::<IterationInput>(empty)
            .expect_err("empty iteration must surface a schema error");
        let message = error.to_string();
        assert!(
            message.contains("startedAtMs")
                || message.contains("completedAtMs")
                || message.contains("outcome")
                || message.contains("summary"),
            "expected field-named error, got: {message}",
        );
    }

    /// Two passing iterations plus a terminal Completed update succeed end
    /// to end. This is the canonical completion path the AgentPanel takes
    /// after a fresh judge crosses threshold.
    #[test]
    fn completion_with_two_passing_iterations_succeeds() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First pass"),
        )
        .unwrap();
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(90_000, "Second pass"),
        )
        .unwrap();
        let report = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(report.status, LoopStatus::Completed);
    }

    #[test]
    fn completion_requires_at_least_two_iterations() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "Only pass"),
        )
        .unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 80_000),
                recorded_at_ms: Some(START + 80_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("requires at least 2 iterations"),
            "expected iteration-count error, got: {message}",
        );
    }

    #[test]
    fn completion_requires_latest_iteration_outcome_passed() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        // Second iteration fails the gate by keeping NeedsWork.
        let mut second = passing_input(90_000, "Needs more work");
        second.outcome = IterationOutcome::NeedsWork;
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("must be passed"),
            "expected outcome-passed error, got: {}",
            error,
        );
    }

    #[test]
    fn completion_requires_a_durable_agent_id() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        // Readiness checks the latest iteration only: drop agent_id there
        // so the gate must reject even when an earlier pass attributed work.
        let mut second = passing_input(90_000, "Second");
        second.agents[0].agent_id = None;
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("agent_id"),
            "expected agent_id error, got: {}",
            error,
        );
    }

    #[test]
    fn completion_requires_passing_build_play_and_test_checks() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        // Strip the test check so the readiness gate sees no passing test.
        let mut second = passing_input(90_000, "No test");
        second.checks.retain(|check| check.kind != CheckKind::Test);
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("passing Test check"),
            "expected test-check error, got: {}",
            error,
        );
    }

    #[test]
    fn completion_requires_a_passing_play_check() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        let mut second = passing_input(90_000, "Play fails");
        for check in &mut second.checks {
            if check.kind == CheckKind::Play {
                check.status = CheckStatus::Failed;
            }
        }
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("passing Play check"),
            "expected play-check error, got: {}",
            error,
        );
    }

    #[test]
    fn completion_requires_visual_evidence() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        let mut second = passing_input(90_000, "No visuals");
        second.evidence.clear();
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("visual evidence"),
            "expected visual-evidence error, got: {}",
            error,
        );
    }

    #[test]
    fn completion_requires_score_at_or_above_default_threshold() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        let mut second = passing_input(90_000, "Score too low");
        if let Some(score) = second.scores.first_mut() {
            score.score = 80;
            score.pass_threshold = None;
        }
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("average score is 80, below 90"),
            "expected default-threshold error, got: {}",
            error,
        );
    }

    #[test]
    fn completion_still_requires_average_ninety_with_a_lower_explicit_threshold() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        // passThreshold is a per-criterion floor, not a way to weaken the
        // overall quality bar shared with the client completion validator.
        let mut second = passing_input(90_000, "Explicit threshold");
        if let Some(score) = second.scores.first_mut() {
            score.score = 70;
            score.pass_threshold = Some(50);
        }
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("average score is 70"));
    }

    #[test]
    fn completion_rejects_a_failed_check_even_when_each_kind_also_passes() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        let mut second = passing_input(90_000, "Conflicting checks");
        second.checks.push(CheckResult {
            kind: CheckKind::Test,
            name: "Regression suite".into(),
            command: Some("pnpm test".into()),
            status: CheckStatus::Failed,
            duration_ms: 500,
            details: "One regression remains".into(),
        });
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("still contains a failed check"));
    }

    #[test]
    fn completion_requires_changed_files_across_the_loop() {
        let (_temp, root) = project_root();
        create_sample(&root);
        let mut first = passing_input(1_000, "First");
        first.changed_files.clear();
        append_iteration(&root, "space-game", "aaa-pass-01", first).unwrap();
        let mut second = passing_input(90_000, "Second");
        second.changed_files.clear();
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("no iteration records changed files"));
    }

    #[test]
    fn completion_requires_structured_next_iteration_memory() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        let mut second = passing_input(90_000, "Empty memory");
        second.next_iteration_memory = NextIterationMemory::default();
        append_iteration(&root, "space-game", "aaa-pass-01", second).unwrap();
        let error = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("nextIterationMemory is empty"),
            "expected memory error, got: {}",
            error,
        );
    }

    /// Re-saving an already-terminal report must skip the readiness gate.
    /// The AgentPanel terminal handler rewrites summary/memory on a
    /// Blocked or Cancelled report, and the same call must remain valid.
    #[test]
    fn terminal_to_terminal_update_does_not_re_check_readiness() {
        let (_temp, root) = project_root();
        create_sample(&root);
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(1_000, "First"),
        )
        .unwrap();
        append_iteration(
            &root,
            "space-game",
            "aaa-pass-01",
            passing_input(90_000, "Second"),
        )
        .unwrap();
        let completed = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                completed_at_ms: Some(START + 200_000),
                recorded_at_ms: Some(START + 200_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(completed.status, LoopStatus::Completed);
        // Re-saving the same terminal status only refreshes the summary;
        // the readiness gate must not fire again.
        let report = update(
            &root,
            "space-game",
            "aaa-pass-01",
            LoopUpdate {
                status: Some(LoopStatus::Completed),
                summary: Some("Final write-up.".into()),
                recorded_at_ms: Some(START + 300_000),
                ..LoopUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(report.status, LoopStatus::Completed);
        assert_eq!(report.summary, "Final write-up.");
    }

    #[test]
    fn normalize_iteration_payload_renames_snake_case_keys_recursively() {
        let raw = serde_json::json!({
            "started_at_ms": 1,
            "completed_at_ms": 2,
            "outcome": "needs-work",
            "summary": "snake_case input",
            "punch_list": [],
            "next_iteration_memory": {
                "next_actions": ["play the game"],
                "observations": [],
                "decisions": [],
                "risks": []
            },
            "nested": [
                { "changed_files": [{ "path": "scripts/player.ts", "additions": 1, "deletions": 0 }] }
            ]
        });
        let normalised = super::normalize_iteration_payload(raw.clone());
        // snake_case keys are gone from the top level...
        assert!(normalised.get("started_at_ms").is_none());
        assert!(normalised.get("punch_list").is_none());
        assert!(normalised.get("next_iteration_memory").is_none());
        // ...and replaced with their camelCase equivalents.
        assert!(normalised.get("startedAtMs").is_some());
        assert!(normalised.get("punchList").is_some());
        assert!(normalised.get("nextIterationMemory").is_some());
        // Nested objects (including those inside arrays) follow suit.
        let nested = &normalised["nested"][0];
        assert!(nested.get("changed_files").is_none());
        assert!(nested.get("changedFiles").is_some());
        // Snake-case keys inside nested_iteration_memory get rewritten.
        let memory = &normalised["nextIterationMemory"];
        assert!(memory.get("next_actions").is_none());
        assert!(memory.get("nextActions").is_some());
        // A round-trip through deserialization proves the contract.
        let parsed: IterationInput = serde_json::from_value(normalised).unwrap();
        assert_eq!(parsed.started_at_ms, 1);
        assert_eq!(
            parsed.next_iteration_memory.next_actions,
            vec!["play the game".to_string()]
        );
    }

    #[test]
    fn normalize_iteration_payload_leaves_already_camel_case_payloads_intact() {
        let raw = serde_json::json!({
            "startedAtMs": 10,
            "completedAtMs": 20,
            "outcome": "passed",
            "summary": "camelCase input",
            "punchList": [],
            "nextIterationMemory": {
                "observations": [],
                "decisions": [],
                "risks": [],
                "nextActions": []
            }
        });
        let normalised = super::normalize_iteration_payload(raw.clone());
        // No underscores means the keys are unchanged.
        assert_eq!(normalised["startedAtMs"], raw["startedAtMs"]);
        assert_eq!(normalised["punchList"], raw["punchList"]);
        let parsed: IterationInput = serde_json::from_value(normalised).unwrap();
        assert_eq!(parsed.summary, "camelCase input");
    }
}

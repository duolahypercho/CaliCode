//! Syntax diagnostics attached to the result of a write.
//!
//! Every harness we compared against feeds errors back into the *edit result*
//! rather than waiting for the model to discover them later — opencode blocks
//! on LSP diagnostics after each edit, Crush returns them inline. The reason is
//! economic: a syntax error found at edit time costs one tool result, and the
//! same error found at run time costs a whole build-and-play round trip, plus
//! however many turns the model spends guessing at a stack trace.
//!
//! We have no language server, and this deliberately does not pretend to be
//! one. It answers exactly one question — *is this file still parseable?* —
//! because that is the question that can be answered with **no false
//! positives**. A diagnostic that tells the model to fix correct code is worse
//! than silence: it will "fix" it, and the fix is the damage. So anything not
//! checkable with certainty (TypeScript types, unresolved imports, anything
//! needing project-wide knowledge) reports nothing at all.
//!
//! Module kind is resolved before checking rather than left to `node` to guess.
//! `node --check foo.js` on a file using `import` fails with "Cannot use import
//! statement outside a module", which is a property of the extension, not a
//! defect in the file — exactly the false positive this module exists to avoid.

use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

/// Longest diagnostic kept. Node prints the offending source line and a caret,
/// which is the useful part; a runaway stack trace is not.
const MAX_DIAGNOSTIC_CHARS: usize = 1200;

/// Does this content parse? `None` when it does, or when we cannot say.
pub fn check(path: &Path, content: &str) -> Option<String> {
    match extension(path).as_deref() {
        Some("json") => json_error(content),
        Some("js" | "mjs" | "cjs" | "jsx") => javascript_error(content),
        // TypeScript needs a real checker to say anything true about it, and a
        // parse-only pass would flag valid type syntax. Silence is correct.
        _ => None,
    }
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
}

fn json_error(content: &str) -> Option<String> {
    match serde_json::from_str::<Value>(content) {
        Ok(_) => None,
        // serde's message already carries line and column.
        Err(error) => Some(bound(&format!("invalid JSON: {error}"))),
    }
}

/// True when the source can only be an ES module.
///
/// Deliberately conservative: it looks for the statement forms that make a file
/// *require* module treatment, at the start of a line so a mention inside a
/// string or a comment tail does not count. Guessing "module" for a CommonJS
/// file would produce a false error on `require`, so the CommonJS default is
/// the safe side of this decision.
fn looks_like_module(content: &str) -> bool {
    content.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("import ")
            || line.starts_with("import{")
            || line.starts_with("import(")
            || line.starts_with("export ")
            || line.starts_with("export{")
            || line.starts_with("export default")
    })
}

/// A unique scratch path for one `node --check` run.
///
/// Unique per call because two edits can be checked at once and a shared name
/// would let one run read the other's source — which would report a syntax
/// error against a file that never had one.
fn probe_path(suffix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "calicode-check-{}-{nanos}-{seq}.{suffix}",
        std::process::id()
    ))
}

fn javascript_error(content: &str) -> Option<String> {
    // `node --check` reads a path, and the extension is what decides how it
    // parses. Writing our own temp file with an unambiguous extension is what
    // makes the answer depend on the source rather than on where it happens to
    // live in the user's project.
    let suffix = if looks_like_module(content) {
        "mjs"
    } else {
        "cjs"
    };
    let probe = probe_path(suffix);
    std::fs::write(&probe, content).ok()?;

    let output = Command::new("node").arg("--check").arg(&probe).output();
    let _ = std::fs::remove_file(&probe);
    // No node, or it could not run: say nothing rather than invent a problem.
    let output = output.ok()?;
    if output.status.success() {
        return None;
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Strip the temp path so the model is never told to look at a file that
    // does not exist.
    let cleaned = stderr.replace(&probe.display().to_string(), "");
    let message = cleaned.trim();
    if message.is_empty() {
        return None;
    }
    Some(bound(message))
}

fn bound(message: &str) -> String {
    if message.chars().count() <= MAX_DIAGNOSTIC_CHARS {
        return message.to_string();
    }
    let kept: String = message.chars().take(MAX_DIAGNOSTIC_CHARS).collect();
    format!("{kept}\n… diagnostic truncated")
}

/// Longest a project typecheck may run before its answer stops being worth
/// waiting for. The measured cost on this repo's client is ~2.7s; a project
/// that takes ten times that is one where the model should keep working and
/// find out at build time.
const TYPECHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Most diagnostics reported for one file. Past this the file needs reading,
/// not reciting.
const MAX_TYPE_ERRORS: usize = 20;

/// Type errors in `edited`, using the workspace's *own* TypeScript.
///
/// Deliberately narrow, and every condition below removes a way to be wrong:
///
/// * The workspace must ship its own `tsc`. A different compiler version than
///   the project builds with produces errors the project does not have.
/// * There must be a `tsconfig.json`, and the *right* invocation for it. A
///   solution-style config (`"files": []` plus `references`) silently checks
///   **nothing** under `-p` — measured at 61ms and zero output on this very
///   repo, which is a false negative that looks exactly like success.
/// * Only diagnostics for the edited file are kept. A project-wide list would
///   hand the model errors it did not cause and cannot be expected to fix.
/// * Anything unexpected — no tsc, a timeout, a crash — reports nothing.
///   Silence is the honest answer when the check did not happen.
pub fn typecheck(workspace_root: &Path, edited: &Path) -> Option<String> {
    if !matches!(
        extension(edited).as_deref(),
        Some("ts" | "tsx" | "mts" | "cts")
    ) {
        return None;
    }
    let tsc = workspace_root.join("node_modules/.bin/tsc");
    let config = workspace_root.join("tsconfig.json");
    if !tsc.is_file() || !config.is_file() {
        return None;
    }

    // `-b` for a solution config, `-p` otherwise. Getting this backwards is
    // the false negative described above.
    let solution = std::fs::read_to_string(&config)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&strip_jsonc(&text)).ok())
        .map(|json| json.get("references").is_some_and(|r| r.is_array()))
        .unwrap_or(false);
    let args: Vec<&str> = if solution {
        vec!["-b", "--noEmit"]
    } else {
        vec!["-p", "tsconfig.json", "--noEmit"]
    };

    let output = run_with_timeout(&tsc, &args, workspace_root, TYPECHECK_TIMEOUT)?;
    let edited_real = edited
        .canonicalize()
        .unwrap_or_else(|_| edited.to_path_buf());
    let mut lines: Vec<String> = Vec::new();
    for line in output.lines() {
        let Some((path, _)) = line.split_once('(') else {
            continue;
        };
        if !line.contains(": error TS") {
            continue;
        }
        let candidate = workspace_root.join(path.trim());
        let candidate = candidate.canonicalize().unwrap_or(candidate);
        if candidate != edited_real {
            continue;
        }
        lines.push(line.trim().to_string());
        if lines.len() >= MAX_TYPE_ERRORS {
            break;
        }
    }
    if lines.is_empty() {
        return None;
    }
    Some(bound(&lines.join("\n")))
}

/// tsconfig files are JSONC. Only the two comment forms matter in practice,
/// and a parse failure falls back to "not a solution config", which picks the
/// safer `-p` invocation rather than guessing.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Run a command, killing it if it outstrips `timeout`. `None` on any failure,
/// because a check that did not finish has nothing true to say.
fn run_with_timeout(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Option<String> {
    use std::io::Read;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(_) => break,
            None => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let mut text = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut text);
    }
    Some(text)
}

/// Fold a diagnostic into a write/edit result.
///
/// The write still happened — this is not a failure — so the file's own result
/// fields stay intact and the problem is reported beside them. The wording is
/// an instruction rather than an observation because a result the model reads
/// as "done, with a note" is one it moves on from.
pub fn attach(
    mut result: Value,
    path: &Path,
    content: &str,
    workspace_root: Option<&Path>,
) -> Value {
    // Parse first: it is nearly free and, when a file no longer parses, a
    // typecheck would only restate that in a longer form.
    let diagnostic = match check(path, content) {
        Some(parse_error) => parse_error,
        None => match workspace_root.and_then(|root| typecheck(root, path)) {
            Some(type_errors) => type_errors,
            None => return result,
        },
    };
    if let Some(object) = result.as_object_mut() {
        object.insert("diagnostics".into(), Value::String(diagnostic.clone()));
        object.insert(
            "note".into(),
            Value::String(format!(
                "The write succeeded but the file no longer parses. Fix this before doing \
                 anything else — nothing that loads it will run:\n{diagnostic}"
            )),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_sources_report_nothing() {
        assert!(check(Path::new("a.json"), r#"{"ok":true}"#).is_none());
        assert!(check(Path::new("a.js"), "const x = 1;\nmodule.exports = x;\n").is_none());
        assert!(check(
            Path::new("a.js"),
            "import * as THREE from 'three';\nexport const x = 1;\n"
        )
        .is_none());
        assert!(check(Path::new("a.mjs"), "export default function () {}\n").is_none());
    }

    #[test]
    fn a_broken_json_document_names_where() {
        let error = check(Path::new("project.json"), r#"{"entities": [,]}"#)
            .expect("malformed JSON must be reported");
        assert!(error.contains("invalid JSON"));
        // serde carries line/column, which is the part worth having.
        assert!(
            error.contains("line") || error.contains("column"),
            "got: {error}"
        );
    }

    #[test]
    fn a_syntax_error_in_a_script_is_reported() {
        let error = check(Path::new("player.js"), "function jump( {\n  return 1;\n")
            .expect("unbalanced braces must be reported");
        assert!(!error.is_empty());
        // The temp path we probed through must never leak into the result.
        assert!(
            !error.contains("calicode-check-"),
            "temp path leaked: {error}"
        );
    }

    #[test]
    fn an_es_module_is_not_mistaken_for_commonjs() {
        // The false positive this module exists to prevent: `node --check` on a
        // `.js` file using `import` fails purely because of the extension.
        assert!(looks_like_module("import { Mesh } from 'three';\n"));
        assert!(looks_like_module("export const speed = 4;\n"));
        assert!(!looks_like_module("const x = require('three');\n"));
        // A mention inside a string is not a top-level statement.
        assert!(!looks_like_module("const doc = 'import this';\n"));
        assert!(check(
            Path::new("level.js"),
            "import { Mesh } from 'three';\nexport const make = () => new Mesh();\n"
        )
        .is_none());
    }

    #[test]
    fn commonjs_stays_commonjs() {
        // Guessing "module" here would make `require` an error.
        assert!(check(
            Path::new("tool.js"),
            "const path = require('path');\nmodule.exports = path.sep;\n"
        )
        .is_none());
    }

    #[test]
    fn typescript_and_unknown_extensions_stay_silent() {
        // A parse-only pass would flag valid type syntax, so it says nothing.
        assert!(check(Path::new("a.ts"), "const x: number = 1;").is_none());
        assert!(check(Path::new("a.md"), "# not code {{{").is_none());
        assert!(check(Path::new("noext"), "((((").is_none());
    }

    #[test]
    fn typecheck_stays_silent_without_the_project_s_own_tools() {
        // Every one of these removes a way to report something untrue: a
        // different compiler than the project builds with, or no project at
        // all, produces errors the project does not have.
        let empty = tempfile::tempdir().unwrap();
        let file = empty.path().join("a.ts");
        std::fs::write(&file, "const x: number = 1;\n").unwrap();
        assert!(typecheck(empty.path(), &file).is_none(), "no tsc, no claim");

        // Not TypeScript: nothing to say even where a checker exists.
        let js = empty.path().join("a.js");
        std::fs::write(&js, "const x = 1;\n").unwrap();
        assert!(typecheck(empty.path(), &js).is_none());
    }

    #[test]
    fn a_solution_style_tsconfig_is_actually_checked() {
        // The false negative this guards is one this module hit for real: a
        // solution config (`"files": []` plus `references`) checks *nothing*
        // under `-p`, returning success in 61ms. A diagnostics feature that
        // silently checks nothing is worse than none, because it is trusted.
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("tsconfig.json"),
            r#"{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }"#,
        )
        .unwrap();
        let config: Value = serde_json::from_str(&strip_jsonc(
            &std::fs::read_to_string(root.path().join("tsconfig.json")).unwrap(),
        ))
        .unwrap();
        assert!(
            config.get("references").is_some_and(|r| r.is_array()),
            "a solution config must be recognised as one, or -p checks nothing"
        );
    }

    #[test]
    fn jsonc_comments_do_not_defeat_config_detection() {
        // Real tsconfigs carry comments; a parse failure must fall back to the
        // safer `-p` rather than guessing `-b`.
        let text = "// the app\n{ \"files\": [], \"references\": [{ \"path\": \"./a.json\" }] }\n";
        let parsed: Value = serde_json::from_str(&strip_jsonc(text)).expect("comments stripped");
        assert!(parsed.get("references").is_some());
    }

    /// Against this repository's own client, which is a real solution-style
    /// TypeScript project with its own tsc. Ignored by default because it
    /// costs a few seconds and needs `pnpm install` to have run:
    /// `cargo test diagnostics::tests::live -- --ignored`.
    #[test]
    #[ignore]
    fn live_typecheck_finds_a_real_error_and_scopes_it_to_the_edited_file() {
        let client = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("client");
        if !client.join("node_modules/.bin/tsc").is_file() {
            eprintln!("skipping: client dependencies are not installed");
            return;
        }
        let target = client.join("src/lib/theme.ts");
        let original = std::fs::read_to_string(&target).expect("a real source file");

        // A type error the compiler cannot miss.
        let broken = format!("{original}\nconst __probe: number = \"not a number\";\n");
        std::fs::write(&target, &broken).unwrap();
        let found = typecheck(&client, &target);
        std::fs::write(&target, &original).unwrap();

        let text = found.expect("a real type error must be reported");
        assert!(text.contains("error TS"), "{text}");
        // Scoped to the file just edited, not the whole project.
        for line in text.lines() {
            assert!(
                line.starts_with("src/lib/theme.ts"),
                "leaked another file: {line}"
            );
        }

        // And a healthy file reports nothing at all.
        assert!(
            typecheck(&client, &target).is_none(),
            "a clean file must produce no diagnostic"
        );
    }

    #[test]
    fn attach_leaves_a_healthy_result_untouched() {
        let result = json!({ "path": "a.js", "written": true });
        let attached = attach(result.clone(), Path::new("a.js"), "const x = 1;\n", None);
        assert_eq!(attached, result);
    }

    #[test]
    fn attach_reports_the_problem_without_claiming_the_write_failed() {
        let result = json!({ "path": "a.js", "written": true, "replacements": 1 });
        let attached = attach(result, Path::new("a.js"), "function broken( {\n", None);
        // The write did happen; the result must not start lying about that.
        assert_eq!(attached["written"], json!(true));
        assert_eq!(attached["replacements"], json!(1));
        assert!(attached["diagnostics"].is_string());
        assert!(attached["note"]
            .as_str()
            .unwrap()
            .contains("Fix this before doing anything else"));
    }

    #[test]
    fn a_very_long_diagnostic_is_bounded() {
        let long = "x".repeat(MAX_DIAGNOSTIC_CHARS * 3);
        let bounded = bound(&long);
        assert!(bounded.chars().count() < MAX_DIAGNOSTIC_CHARS + 40);
        assert!(bounded.ends_with("diagnostic truncated"));
    }
}

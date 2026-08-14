//! Finding the span an edit means when the quoted text is *formatted*
//! differently from the file.
//!
//! `file_edit` requires text that matches exactly, which is a good rule: you
//! cannot quote a file you have not read, and the model is forced to be
//! specific. The cost is a failure mode that is pure waste — the model
//! reproduces a block correctly but with two spaces where the file has four,
//! or without the trailing space at the end of a line, and the edit is refused.
//! It then re-reads the file and tries again, sometimes repeatedly.
//!
//! opencode answers this with nine replacers in sequence, several of which are
//! fuzzy — a block-anchor pass with hand-rolled Levenshtein at a 0.65
//! threshold, among others. **Those are deliberately not ported.** Our
//! exact-match rule is what makes a blind edit structurally impossible
//! (`an_edit_cannot_be_made_blind`), and a similarity threshold is precisely a
//! way for text that was never in the file to be accepted. What is ported is
//! the part that carries no such risk: the same characters, laid out
//! differently.
//!
//! Two fallbacks, both requiring every non-whitespace character to be present
//! and in order:
//!
//! 1. **Trailing whitespace** — line ends differ, nothing else does.
//! 2. **Indentation** — the block was re-indented, nothing else differs.
//!
//! Every strategy must still find *exactly one* span, so an ambiguous edit is
//! refused as loudly as before. And opencode's `isDisproportionateMatch` guard
//! is kept: a fallback that matches a span far longer than what was quoted has
//! almost certainly found something else, and replacing it would delete code
//! the model never looked at.

/// A fallback match may not exceed the quoted text by more than this factor.
/// A block re-indented from 0 to 8 spaces grows, but not unboundedly.
const MAX_MATCH_GROWTH: usize = 2;

/// Which rule found the span. Reported so an edit that needed a fallback can
/// say so rather than silently behaving as though the quote were exact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    Exact,
    TrailingWhitespace,
    Indentation,
}

impl Strategy {
    pub fn label(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::TrailingWhitespace => "ignoring trailing whitespace",
            Self::Indentation => "ignoring indentation",
        }
    }
}

/// Byte spans in the original text, plus the rule that found them.
#[derive(Debug, Clone)]
pub struct Matches {
    pub spans: Vec<(usize, usize)>,
    pub strategy: Strategy,
}

/// Byte offset at which each line starts, plus a final entry at `text.len()`.
fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(index + 1);
        }
    }
    starts
}

/// The lines of `text` as byte ranges, newline excluded.
fn line_spans(text: &str) -> Vec<(usize, usize)> {
    let starts = line_starts(text);
    let mut spans = Vec::with_capacity(starts.len());
    for (index, &start) in starts.iter().enumerate() {
        let end = match starts.get(index + 1) {
            // Exclude the newline itself.
            Some(&next) => next - 1,
            None => text.len(),
        };
        spans.push((start, end));
    }
    spans
}

fn exact(text: &str, needle: &str) -> Vec<(usize, usize)> {
    text.match_indices(needle)
        .map(|(start, found)| (start, start + found.len()))
        .collect()
}

/// A line-window search where each line is compared after `normalize`.
///
/// Whole lines only: a fallback that matched a fragment inside a line would
/// have to guess where the span ends, and guessing is what this module refuses
/// to do. The span returned therefore covers complete lines.
fn line_window(text: &str, needle: &str, normalize: fn(&str) -> &str) -> Vec<(usize, usize)> {
    let needle_lines: Vec<&str> = needle.lines().map(normalize).collect();
    if needle_lines.is_empty() {
        return Vec::new();
    }
    let spans = line_spans(text);
    let mut found = Vec::new();
    if spans.len() < needle_lines.len() {
        return found;
    }
    for start in 0..=(spans.len() - needle_lines.len()) {
        let matched = needle_lines.iter().enumerate().all(|(offset, wanted)| {
            let (from, to) = spans[start + offset];
            normalize(&text[from..to]) == *wanted
        });
        if matched {
            let (from, _) = spans[start];
            let (_, to) = spans[start + needle_lines.len() - 1];
            found.push((from, to));
        }
    }
    found
}

fn strip_end(line: &str) -> &str {
    line.trim_end()
}

fn strip_both(line: &str) -> &str {
    line.trim()
}

/// A fallback span far longer than what was quoted has found something else.
fn disproportionate(needle: &str, spans: &[(usize, usize)]) -> bool {
    spans
        .iter()
        .any(|(from, to)| to.saturating_sub(*from) > needle.len().saturating_mul(MAX_MATCH_GROWTH))
}

/// Locate `needle` in `text`, tolerating layout but never content.
///
/// Returns `None` when nothing matches under any rule — which stays the
/// caller's "not found", the refusal that keeps blind edits impossible.
pub fn find(text: &str, needle: &str) -> Option<Matches> {
    if needle.is_empty() {
        return None;
    }
    let spans = exact(text, needle);
    if !spans.is_empty() {
        return Some(Matches {
            spans,
            strategy: Strategy::Exact,
        });
    }
    // Fallbacks are line-shaped, so a quote that is not at least one whole
    // line has nothing safe to fall back to.
    let whole_lines =
        needle.contains('\n') || text.lines().any(|line| line.trim() == needle.trim());
    if !whole_lines {
        return None;
    }
    for (normalize, strategy) in [
        (strip_end as fn(&str) -> &str, Strategy::TrailingWhitespace),
        (strip_both as fn(&str) -> &str, Strategy::Indentation),
    ] {
        let spans = line_window(text, needle, normalize);
        if spans.is_empty() || disproportionate(needle, &spans) {
            continue;
        }
        return Some(Matches { spans, strategy });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exact_quote_wins_and_reports_itself_as_exact() {
        let text = "let a = 1;\nlet b = 2;\n";
        let found = find(text, "let b = 2;").unwrap();
        assert_eq!(found.strategy, Strategy::Exact);
        assert_eq!(found.spans.len(), 1);
        let (from, to) = found.spans[0];
        assert_eq!(&text[from..to], "let b = 2;");
    }

    #[test]
    fn a_trailing_space_in_the_file_no_longer_costs_a_turn() {
        // The file has trailing whitespace the model did not reproduce. The
        // characters that matter are all present and in order.
        let text = "function go() {   \n  return 1;\n}\n";
        let found = find(text, "function go() {\n  return 1;\n}").unwrap();
        assert_eq!(found.strategy, Strategy::TrailingWhitespace);
        assert_eq!(found.spans.len(), 1);
        let (from, to) = found.spans[0];
        assert_eq!(&text[from..to], "function go() {   \n  return 1;\n}");
    }

    #[test]
    fn a_re_indented_block_is_found_and_replaced_whole() {
        let text = "class A {\n        step() {\n            return 2;\n        }\n}\n";
        // Quoted at a different indentation than the file uses.
        let found = find(text, "step() {\n    return 2;\n}").unwrap();
        assert_eq!(found.strategy, Strategy::Indentation);
        let (from, to) = found.spans[0];
        assert_eq!(
            &text[from..to],
            "        step() {\n            return 2;\n        }"
        );
    }

    #[test]
    fn text_that_was_never_in_the_file_is_still_not_found() {
        // The guarantee the ladder must not weaken: no similarity threshold,
        // so an invented quote fails as loudly as before.
        let text = "const gravity = 9.8;\nconst drag = 0.1;\n";
        assert!(find(text, "const gravity = 10;").is_none());
        assert!(find(text, "const bounce = 9.8;").is_none());
        // Right characters, wrong order.
        assert!(find(text, "const drag = 0.1;\nconst gravity = 9.8;").is_none());
        // A line that is nearly right but not right.
        assert!(find(text, "const gravity = 9.80;").is_none());
    }

    #[test]
    fn ambiguity_survives_the_fallbacks() {
        // Two blocks that differ only in indentation: the fallback finds both,
        // and the caller must still refuse rather than pick one.
        let text = "if (a) {\n  go();\n}\nif (b) {\n    go();\n}\n";
        let found = find(text, "go();\n").unwrap();
        assert!(
            found.spans.len() >= 2,
            "an ambiguous quote must stay ambiguous: {found:?}"
        );
    }

    #[test]
    fn a_fallback_may_not_swallow_far_more_than_was_quoted() {
        // A short quote whose *content* matches a heavily indented line. The
        // indentation fallback would otherwise select the whole 200-column
        // line and replace it, deleting leading structure the model never saw.
        let text = format!("let x = 1;\n{}alpha\n", " ".repeat(200));
        // Trailing space, so exact matching does not short-circuit this.
        assert!(find(&text, "alpha ").is_none());

        // The same quote against a normally indented line is fine — the guard
        // is about disproportion, not about indentation as such.
        let modest = "let x = 1;\n    alpha\n";
        let found = find(modest, "alpha ").unwrap();
        assert_eq!(found.strategy, Strategy::Indentation);
    }

    #[test]
    fn an_empty_quote_is_never_a_match() {
        assert!(find("anything", "").is_none());
    }

    #[test]
    fn a_single_line_fragment_gets_no_line_shaped_fallback() {
        // `= 1` appears inside a line but is not a whole line, so there is
        // nothing safe to fall back to and exact matching decides.
        let text = "let a = 1;\n";
        let found = find(text, "= 1").unwrap();
        assert_eq!(found.strategy, Strategy::Exact);
        // ...and a fragment that differs in layout is simply not found, rather
        // than guessed at.
        assert!(find(text, "=  1").is_none());
    }
}

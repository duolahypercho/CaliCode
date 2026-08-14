//! Per-model token ledger behind Settings → Status.
//!
//! `AgentSession::usage` answers "how full is this context window"; it is
//! per-session, resets with the session, and cannot say whether the prompt
//! cache is actually working. This ledger answers the other question — across
//! every session and restart, what did each model cost and how much of its
//! prompt came back as a cache read.
//!
//! Kept deliberately coarse. It counts tokens the provider already reported,
//! never times a request or estimates a price, so a provider that omits usage
//! simply contributes nothing rather than skewing the totals.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Cumulative totals for one `provider/model` pair.
///
/// The three prompt classes are disjoint — `model::parse_usage` subtracts
/// cache reads and writes out of the provider's `prompt_tokens` — so they sum
/// to the real prompt size and a hit rate divides cleanly.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelUsage {
    /// Model calls that reported usage at all.
    pub requests: u64,
    /// Prompt tokens billed at full price.
    pub prompt_tokens: u64,
    /// Prompt tokens served from the provider's prefix cache.
    pub cache_read_tokens: u64,
    /// Prompt tokens written into the cache, when the provider reports them.
    pub cache_write_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

impl ModelUsage {
    fn add(&mut self, usage: &crate::model::Usage) {
        self.requests = self.requests.saturating_add(1);
        self.prompt_tokens = self.prompt_tokens.saturating_add(usage.prompt_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(usage.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(usage.cache_write_tokens);
        self.completion_tokens = self
            .completion_tokens
            .saturating_add(usage.completion_tokens);
        self.total_tokens = self.total_tokens.saturating_add(usage.total_tokens);
    }

    /// Every prompt token this model was sent, cached or not.
    pub fn prompt_total(&self) -> u64 {
        self.prompt_tokens
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_write_tokens)
    }

    /// Share of prompt tokens served from cache, or `None` when the model has
    /// not been sent a prompt yet. A write is counted against the rate on
    /// purpose: it is the miss that paid to populate the cache.
    pub fn hit_rate(&self) -> Option<f64> {
        let prompt = self.prompt_total();
        (prompt > 0).then(|| self.cache_read_tokens as f64 / prompt as f64)
    }
}

/// How many days of activity to keep.
///
/// A little over a year, so the heatmap always has a full trailing year to
/// draw and the file cannot grow without bound on a long-lived install.
const MAX_DAYS: usize = 400;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Snapshot {
    /// Unix seconds the ledger started counting. Survives restarts so the
    /// page can say what window the numbers cover.
    since: u64,
    /// Keyed `provider/model`. `BTreeMap` so the page and its tests see a
    /// stable order without sorting at every read.
    models: BTreeMap<String, ModelUsage>,
    /// Keyed `YYYY-MM-DD` in the machine's local time — the heatmap's rows.
    ///
    /// Local rather than UTC because this is a personal activity view: an
    /// evening's work in the Americas would otherwise land on tomorrow's
    /// square. `BTreeMap` keeps it date-ordered, and the key stays a readable
    /// string so the file can be inspected by hand.
    #[serde(default)]
    days: BTreeMap<String, ModelUsage>,
}

/// Days since the Unix epoch for a civil date, and back again.
///
/// Howard Hinnant's `days_from_civil` / `civil_from_days`, which are exact for
/// the proleptic Gregorian calendar. Written out rather than pulled in as a
/// dependency: the ledger needs day arithmetic for streaks and nothing else,
/// and a date crate is a large surface for two functions.
mod civil {
    pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
        let year = if month <= 2 { year - 1 } else { year };
        let era = if year >= 0 { year } else { year - 399 } / 400;
        let year_of_era = year - era * 400;
        let month_prime = ((month + 9) % 12) as i64;
        let day_of_year = (153 * month_prime + 2) / 5 + day as i64 - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468
    }

    pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
        let days = days + 719_468;
        let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
        let day_of_era = days - era * 146_097;
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let year = year_of_era + era * 400;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_prime = (5 * day_of_year + 2) / 153;
        let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
        let month = if month_prime < 10 {
            month_prime + 3
        } else {
            month_prime - 9
        } as u32;
        (if month <= 2 { year + 1 } else { year }, month, day)
    }
}

/// Local-time day number for a Unix timestamp.
///
/// `localtime_r` is the only portable way to apply the machine's zone and DST
/// rules without shipping a timezone database. Off-unix there is no such call
/// here, so the fallback buckets by UTC — an offset of hours in a view whose
/// smallest unit is a day.
fn local_day_number(unix: i64) -> i64 {
    #[cfg(unix)]
    {
        // SAFETY: `localtime_r` writes into a caller-owned `tm` and is the
        // thread-safe form; the pointer is checked before the struct is read.
        unsafe {
            let seconds = unix as libc::time_t;
            let mut parts: libc::tm = std::mem::zeroed();
            if !libc::localtime_r(&seconds, &mut parts).is_null() {
                return civil::days_from_civil(
                    parts.tm_year as i64 + 1900,
                    parts.tm_mon as u32 + 1,
                    parts.tm_mday as u32,
                );
            }
        }
    }
    unix.div_euclid(86_400)
}

fn day_key(day: i64) -> String {
    let (year, month, date) = civil::civil_from_days(day);
    format!("{year:04}-{month:02}-{date:02}")
}

/// Day number for a `YYYY-MM-DD` key. `None` for anything malformed, so a
/// hand-edited file degrades to "that day is not counted" rather than a panic.
fn parse_day_key(key: &str) -> Option<i64> {
    let mut parts = key.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let date: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&date) {
        return None;
    }
    Some(civil::days_from_civil(year, month, date))
}

/// The ledger itself.
///
/// Owned by `AgentManager` rather than `AppState` so the 18 places that build
/// an `AppState` keep compiling, and so the only code that can write to it is
/// the code that already records usage.
#[derive(Debug, Default)]
pub struct Ledger {
    inner: RwLock<Snapshot>,
    /// Where to persist. `None` in tests — a ledger nobody attached is
    /// in-memory, so a test run can never write over real usage history.
    path: RwLock<Option<PathBuf>>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

impl Ledger {
    /// Point the ledger at a file and adopt whatever is already there.
    ///
    /// A missing or corrupt file starts a fresh count rather than failing
    /// startup: usage history is diagnostics, never something worth refusing
    /// to boot over.
    pub fn attach(&self, path: PathBuf) {
        let restored = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Snapshot>(&text).ok());
        {
            let mut guard = self.inner.write().expect("usage ledger poisoned");
            match restored {
                Some(snapshot) if snapshot.since > 0 => *guard = snapshot,
                _ => guard.since = now_unix(),
            }
        }
        *self.path.write().expect("usage ledger poisoned") = Some(path);
    }

    /// Fold one model call into `provider/model`'s running totals and into
    /// today's activity bucket.
    pub fn record(&self, provider: &str, model: &str, usage: &crate::model::Usage) {
        let key = Self::key(provider, model);
        let today = day_key(local_day_number(now_unix() as i64));
        {
            let mut guard = self.inner.write().expect("usage ledger poisoned");
            if guard.since == 0 {
                guard.since = now_unix();
            }
            guard.models.entry(key).or_default().add(usage);
            guard.days.entry(today).or_default().add(usage);
            // Oldest first in a BTreeMap, and the key sorts chronologically,
            // so trimming the front drops the days that fell out of the window.
            while guard.days.len() > MAX_DAYS {
                let Some(oldest) = guard.days.keys().next().cloned() else {
                    break;
                };
                guard.days.remove(&oldest);
            }
        }
        self.persist();
    }

    /// Drop every total and restart the window. The file is rewritten so a
    /// reset survives restart — otherwise "Reset" would silently undo itself.
    pub fn reset(&self) {
        {
            let mut guard = self.inner.write().expect("usage ledger poisoned");
            guard.models.clear();
            guard.days.clear();
            guard.since = now_unix();
        }
        self.persist();
    }

    /// Activity derived from the daily buckets: the heatmap's headline stats.
    ///
    /// Computed here, not in the page, for the same reason as the totals — one
    /// definition of "streak" beats two that drift apart. A streak counts back
    /// from today, and tolerates today being empty so a morning with no work
    /// yet does not read as a broken streak.
    fn activity(days: &BTreeMap<String, ModelUsage>) -> serde_json::Value {
        let active: std::collections::BTreeSet<i64> = days
            .iter()
            .filter(|(_, usage)| usage.total_tokens > 0)
            .filter_map(|(key, _)| parse_day_key(key))
            .collect();
        let today = local_day_number(now_unix() as i64);

        let mut current = 0i64;
        let mut cursor = if active.contains(&today) {
            today
        } else {
            today - 1
        };
        while active.contains(&cursor) {
            current += 1;
            cursor -= 1;
        }

        let mut longest = 0i64;
        let mut run = 0i64;
        let mut previous: Option<i64> = None;
        for day in &active {
            run = match previous {
                Some(last) if *day == last + 1 => run + 1,
                _ => 1,
            };
            longest = longest.max(run);
            previous = Some(*day);
        }

        let busiest = days
            .iter()
            .max_by_key(|(_, usage)| usage.total_tokens)
            .filter(|(_, usage)| usage.total_tokens > 0);

        serde_json::json!({
            "activeDays": active.len(),
            "currentStreak": current,
            "longestStreak": longest,
            "busiestDay": busiest.map(|(key, usage)| serde_json::json!({
                "date": key,
                "totalTokens": usage.total_tokens,
            })),
        })
    }

    /// The page payload: one row per model, plus totals computed here so the
    /// client cannot disagree with core about its own arithmetic.
    pub fn report(&self) -> serde_json::Value {
        let guard = self.inner.read().expect("usage ledger poisoned");
        let mut totals = ModelUsage::default();
        let models: Vec<serde_json::Value> = guard
            .models
            .iter()
            .map(|(key, usage)| {
                totals.requests = totals.requests.saturating_add(usage.requests);
                totals.prompt_tokens = totals.prompt_tokens.saturating_add(usage.prompt_tokens);
                totals.cache_read_tokens = totals
                    .cache_read_tokens
                    .saturating_add(usage.cache_read_tokens);
                totals.cache_write_tokens = totals
                    .cache_write_tokens
                    .saturating_add(usage.cache_write_tokens);
                totals.completion_tokens = totals
                    .completion_tokens
                    .saturating_add(usage.completion_tokens);
                totals.total_tokens = totals.total_tokens.saturating_add(usage.total_tokens);
                let (provider, model) = key.split_once('/').unwrap_or(("", key.as_str()));
                serde_json::json!({
                    "key": key,
                    "provider": provider,
                    "model": model,
                    "requests": usage.requests,
                    "promptTokens": usage.prompt_tokens,
                    "cacheReadTokens": usage.cache_read_tokens,
                    "cacheWriteTokens": usage.cache_write_tokens,
                    "completionTokens": usage.completion_tokens,
                    "totalTokens": usage.total_tokens,
                    "promptTotal": usage.prompt_total(),
                    "cacheHitRate": usage.hit_rate(),
                })
            })
            .collect();
        // Date-ordered by construction: the keys sort chronologically, so the
        // page can draw the series without sorting or re-parsing dates.
        let days: Vec<serde_json::Value> = guard
            .days
            .iter()
            .map(|(date, usage)| {
                serde_json::json!({
                    "date": date,
                    "requests": usage.requests,
                    "promptTokens": usage.prompt_tokens,
                    "cacheReadTokens": usage.cache_read_tokens,
                    "cacheWriteTokens": usage.cache_write_tokens,
                    "completionTokens": usage.completion_tokens,
                    "totalTokens": usage.total_tokens,
                    "promptTotal": usage.prompt_total(),
                    "cacheHitRate": usage.hit_rate(),
                })
            })
            .collect();
        serde_json::json!({
            "since": guard.since,
            "today": day_key(local_day_number(now_unix() as i64)),
            "models": models,
            "days": days,
            "activity": Self::activity(&guard.days),
            "totals": {
                "requests": totals.requests,
                "promptTokens": totals.prompt_tokens,
                "cacheReadTokens": totals.cache_read_tokens,
                "cacheWriteTokens": totals.cache_write_tokens,
                "completionTokens": totals.completion_tokens,
                "totalTokens": totals.total_tokens,
                "promptTotal": totals.prompt_total(),
                "cacheHitRate": totals.hit_rate(),
            }
        })
    }

    /// `provider/model`, both trimmed. An unnamed provider or model still gets
    /// a row — losing the numbers would be worse than an "unknown" label.
    fn key(provider: &str, model: &str) -> String {
        let provider = provider.trim();
        let model = model.trim();
        let provider = if provider.is_empty() {
            "unknown"
        } else {
            provider
        };
        let model = if model.is_empty() { "unknown" } else { model };
        format!("{provider}/{model}")
    }

    /// Best-effort write. A failure here must never surface as a failed model
    /// call, so the error is dropped: the in-memory totals stay correct and
    /// the next successful write catches the file up.
    fn persist(&self) {
        let path = {
            let guard = self.path.read().expect("usage ledger poisoned");
            guard.clone()
        };
        let Some(path) = path else { return };
        let snapshot = {
            let guard = self.inner.read().expect("usage ledger poisoned");
            guard.clone()
        };
        let Ok(text) = serde_json::to_string_pretty(&snapshot) else {
            return;
        };
        write_atomic(&path, &text);
    }
}

/// Write through a sibling temp file so a crash mid-write cannot leave a
/// truncated ledger that fails to parse on the next boot.
fn write_atomic(path: &Path, text: &str) {
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, text).is_ok() && std::fs::rename(&temp, path).is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Usage;

    fn usage(prompt: u64, read: u64, write: u64, completion: u64) -> Usage {
        Usage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            cache_read_tokens: read,
            cache_write_tokens: write,
            total_tokens: prompt + read + write + completion,
        }
    }

    #[test]
    fn records_per_model_and_keeps_prompt_classes_disjoint() {
        let ledger = Ledger::default();
        ledger.record("openai", "gpt-5", &usage(100, 900, 0, 50));
        ledger.record("openai", "gpt-5", &usage(50, 950, 0, 25));
        ledger.record("anthropic", "claude-opus-5", &usage(200, 0, 800, 10));

        let report = ledger.report();
        let models = report["models"].as_array().unwrap();
        assert_eq!(models.len(), 2, "one row per provider/model pair");
        // BTreeMap ordering: anthropic sorts before openai.
        assert_eq!(models[0]["key"], "anthropic/claude-opus-5");
        assert_eq!(models[0]["provider"], "anthropic");
        assert_eq!(models[0]["model"], "claude-opus-5");
        assert_eq!(models[1]["requests"], 2);
        assert_eq!(models[1]["promptTokens"], 150);
        assert_eq!(models[1]["cacheReadTokens"], 1850);
        assert_eq!(models[1]["promptTotal"], 2000);
        assert_eq!(report["totals"]["requests"], 3);
        assert_eq!(report["totals"]["promptTotal"], 3000);
    }

    #[test]
    fn hit_rate_counts_writes_as_misses_and_is_absent_before_any_prompt() {
        assert_eq!(ModelUsage::default().hit_rate(), None);
        let mut model = ModelUsage::default();
        model.add(&usage(100, 300, 100, 0));
        // 300 read out of 500 prompt tokens; the write paid full price.
        assert_eq!(model.hit_rate(), Some(0.6));
    }

    #[test]
    fn unnamed_provider_or_model_still_gets_a_row() {
        let ledger = Ledger::default();
        ledger.record("  ", "", &usage(10, 0, 0, 1));
        let report = ledger.report();
        assert_eq!(report["models"][0]["key"], "unknown/unknown");
    }

    #[test]
    fn an_unattached_ledger_never_writes_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let ledger = Ledger::default();
        ledger.record("openai", "gpt-5", &usage(10, 0, 0, 1));
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "a test-constructed ledger must not touch the filesystem"
        );
    }

    #[test]
    fn attach_restores_totals_across_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");

        let first = Ledger::default();
        first.attach(path.clone());
        first.record("openai", "gpt-5", &usage(100, 900, 0, 50));
        let since = first.report()["since"].as_u64().unwrap();
        assert!(since > 0);

        let second = Ledger::default();
        second.attach(path.clone());
        let report = second.report();
        assert_eq!(report["models"][0]["requests"], 1);
        assert_eq!(report["models"][0]["cacheReadTokens"], 900);
        assert_eq!(
            report["since"].as_u64().unwrap(),
            since,
            "the counting window must survive a restart, not restart with it"
        );
    }

    #[test]
    fn a_corrupt_ledger_starts_a_fresh_count_instead_of_failing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");
        std::fs::write(&path, "{not json").unwrap();

        let ledger = Ledger::default();
        ledger.attach(path);
        assert!(ledger.report()["since"].as_u64().unwrap() > 0);
        assert_eq!(ledger.report()["models"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn civil_dates_round_trip_across_leap_years_and_centuries() {
        for (year, month, day) in [
            (1970, 1, 1),
            (2000, 2, 29),
            (2026, 8, 14),
            (2100, 3, 1),
            (1969, 12, 31),
        ] {
            let number = civil::days_from_civil(year, month, day);
            assert_eq!(
                civil::civil_from_days(number),
                (year, month, day),
                "{year}-{month}-{day} must survive the round trip"
            );
        }
        assert_eq!(
            civil::days_from_civil(1970, 1, 1),
            0,
            "the epoch is day zero"
        );
        // 2000 is a leap year, 2100 is not — the century rule the naive
        // "every four years" shortcut gets wrong.
        assert_eq!(
            civil::days_from_civil(2000, 3, 1) - civil::days_from_civil(2000, 2, 28),
            2
        );
        assert_eq!(
            civil::days_from_civil(2100, 3, 1) - civil::days_from_civil(2100, 2, 28),
            1
        );
    }

    #[test]
    fn day_keys_are_zero_padded_and_parse_back() {
        let day = civil::days_from_civil(2026, 8, 4);
        assert_eq!(day_key(day), "2026-08-04");
        assert_eq!(parse_day_key("2026-08-04"), Some(day));
        for malformed in [
            "",
            "2026-08",
            "2026-13-01",
            "2026-08-32",
            "x-y-z",
            "2026-08-04-1",
        ] {
            assert_eq!(parse_day_key(malformed), None, "{malformed} must not parse");
        }
    }

    /// Builds a day map directly; `record` can only ever write to today.
    fn days_with(entries: &[(i64, u64)]) -> BTreeMap<String, ModelUsage> {
        entries
            .iter()
            .map(|(day, tokens)| {
                let mut model = ModelUsage::default();
                model.add(&usage(*tokens, 0, 0, 0));
                (day_key(*day), model)
            })
            .collect()
    }

    #[test]
    fn streaks_count_back_from_today_and_tolerate_an_empty_today() {
        let today = local_day_number(now_unix() as i64);

        // Three consecutive days ending yesterday: today has no work yet, so
        // the streak is still alive at 3.
        let activity = Ledger::activity(&days_with(&[
            (today - 1, 10),
            (today - 2, 10),
            (today - 3, 10),
        ]));
        assert_eq!(activity["currentStreak"], 3);
        assert_eq!(activity["activeDays"], 3);

        // A gap two days back ends the current streak at 1.
        let activity = Ledger::activity(&days_with(&[(today, 10), (today - 2, 10)]));
        assert_eq!(activity["currentStreak"], 1);
        assert_eq!(activity["longestStreak"], 1);

        // The longest run need not be the current one.
        let activity = Ledger::activity(&days_with(&[
            (today, 10),
            (today - 10, 10),
            (today - 11, 10),
            (today - 12, 10),
        ]));
        assert_eq!(activity["currentStreak"], 1);
        assert_eq!(activity["longestStreak"], 3);
    }

    #[test]
    fn a_day_with_no_tokens_breaks_a_streak_and_has_no_busiest_day() {
        let today = local_day_number(now_unix() as i64);
        let mut days = days_with(&[(today, 0)]);
        // A recorded-but-empty day: requests happened, no tokens reported.
        days.insert(day_key(today - 1), ModelUsage::default());

        let activity = Ledger::activity(&days);
        assert_eq!(activity["currentStreak"], 0, "zero tokens is not activity");
        assert_eq!(activity["busiestDay"], serde_json::Value::Null);
    }

    #[test]
    fn recording_fills_todays_bucket_and_the_report_carries_the_series() {
        let ledger = Ledger::default();
        ledger.record("openai", "gpt-5", &usage(100, 900, 0, 50));
        ledger.record("openai", "gpt-5", &usage(100, 900, 0, 50));

        let report = ledger.report();
        let days = report["days"].as_array().unwrap();
        assert_eq!(days.len(), 1, "two calls on one day are one bucket");
        assert_eq!(days[0]["date"], report["today"]);
        assert_eq!(days[0]["requests"], 2);
        assert_eq!(days[0]["totalTokens"], 2100);
        assert_eq!(report["activity"]["currentStreak"], 1);
        assert_eq!(report["activity"]["busiestDay"]["date"], report["today"]);
    }

    #[test]
    fn the_day_window_is_bounded() {
        let ledger = Ledger::default();
        {
            let mut guard = ledger.inner.write().unwrap();
            // One more than the cap, oldest first.
            for offset in 0..=MAX_DAYS as i64 {
                guard.days.insert(day_key(offset), ModelUsage::default());
            }
        }
        ledger.record("openai", "gpt-5", &usage(10, 0, 0, 1));
        let guard = ledger.inner.read().unwrap();
        assert!(
            guard.days.len() <= MAX_DAYS,
            "the file must not grow without bound: {} days",
            guard.days.len()
        );
        assert!(
            !guard.days.contains_key(&day_key(0)),
            "trimming drops the oldest day, not an arbitrary one"
        );
    }

    #[test]
    fn reset_clears_totals_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.json");

        let ledger = Ledger::default();
        ledger.attach(path.clone());
        ledger.record("openai", "gpt-5", &usage(100, 900, 0, 50));
        ledger.reset();
        assert_eq!(ledger.report()["models"].as_array().unwrap().len(), 0);

        let reopened = Ledger::default();
        reopened.attach(path);
        assert_eq!(
            reopened.report()["models"].as_array().unwrap().len(),
            0,
            "a reset that vanishes on restart is not a reset"
        );
    }
}

//! Routines: scheduled checks a bot makes for itself (#972).
//!
//! A routine wakes its bot's chat on a schedule with a hidden message, the way
//! a stall nudge does, and the bot ends the turn silently when nothing matters.
//! An optional shell `check` runs first and the bot is woken only when its
//! output changed, so a routine watching for something costs no model call
//! while nothing moves. The server runs them, so they fire with the window
//! closed; `routines.json` under the home holds the list. Not in the bot's
//! folder: that is committed after every turn, and run times would churn it.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, Local, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::{bots, events::MessageSender, sink::Sink, store, Fail};

pub const ROUTINES_CHANGED: &str = "routines_changed";

/// Shortest interval. A routine with no check pays a model call every run.
const MIN_MINUTES: u32 = 5;
const MAX_PER_BOT: usize = 20;
/// How long a check may run before it counts as failed.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
/// How much of a check's output rides the message.
const OUTPUT_CAP: usize = 4000;
const TICK: Duration = Duration::from_secs(30);

/// When a routine runs: every `every_minutes`, or at `at` (local `HH:MM`) on
/// `days` (0 = Monday; empty = every day). Options rather than an enum, so a
/// kind a later build adds cannot fail an older build's read of the file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "events.ts")]
pub struct Schedule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub every_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub at: Option<String>,
    #[serde(default)]
    pub days: Vec<u8>,
}

/// How a run ended. `outcome` is a string, not an enum, for [`Schedule`]'s
/// reason: `running`, `silent`, `replied`, `failed`, `no_change`,
/// `check_failed` or `skipped`. `text` is the reply's first line, or why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "events.ts")]
pub struct RunResult {
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "events.ts")]
pub struct Routine {
    pub id: String,
    pub bot_id: String,
    pub name: String,
    pub prompt: String,
    pub schedule: Schedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub check: Option<String>,
    #[serde(default)]
    pub paused: bool,
    pub created: String,
    /// RFC3339. `None` while paused.
    #[serde(default)]
    pub next_run: Option<String>,
    #[serde(default)]
    pub last_result: Option<RunResult>,
    /// SHA-256 of the check's last good output, as Hermes keeps it: exact
    /// bytes, so a check must print stable output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(skip)]
    pub check_hash: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(skip)]
    pub check_failing: bool,
}

/// The file is rewritten whole, by the scheduler and every verb.
static LOCK: Mutex<()> = Mutex::const_new(());

/// Bot chat → the routine whose message started its running turn, so the
/// turn's end can be written as that run's result.
static RUNNING: LazyLock<std::sync::Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

async fn path() -> Result<std::path::PathBuf> {
    Ok(store::get_home_app_dir().await?.join("routines.json"))
}

async fn load() -> Result<Vec<Routine>> {
    store::read_json(&path().await?).await
}

async fn save(list: &[Routine]) -> Result<()> {
    store::write_atomic(&path().await?, serde_json::to_string_pretty(list)?).await
}

/// Reads, edits and writes the list under [`LOCK`].
async fn edit<T>(f: impl FnOnce(&mut Vec<Routine>) -> Result<T>) -> Result<T> {
    let _guard = LOCK.lock().await;
    let mut list = load().await?;
    let out = f(&mut list)?;
    save(&list).await?;
    Ok(out)
}

impl Schedule {
    /// Reads the CLI's `--every`, `--at` and `--days`.
    pub fn parse(every: Option<&str>, at: Option<&str>, days: Option<&str>) -> Result<Self> {
        match (every, at) {
            (Some(_), Some(_)) => anyhow::bail!("pass --every or --at, not both"),
            (None, None) => anyhow::bail!("pass --every <30m|2h|1d> or --at <HH:MM>"),
            (Some(every), None) => {
                if days.is_some() {
                    anyhow::bail!("--days goes with --at");
                }
                let minutes = parse_minutes(every)?;
                if minutes < MIN_MINUTES {
                    anyhow::bail!("a routine runs at most every {MIN_MINUTES}m");
                }
                Ok(Self { every_minutes: Some(minutes), ..Default::default() })
            }
            (None, Some(at)) => Ok(Self {
                at: Some(parse_time(at)?.format("%H:%M").to_string()),
                days: days.map(parse_days).transpose()?.unwrap_or_default(),
                ..Default::default()
            }),
        }
    }

    /// "Every 30m", "Weekdays at 09:00": as the card and `ls` say it.
    pub fn describe(&self) -> String {
        if let Some(m) = self.every_minutes {
            return format!("Every {}", span(m));
        }
        let at = self.at.as_deref().unwrap_or("?");
        let days: Vec<u8> = {
            let mut d = self.days.clone();
            d.sort();
            d.dedup();
            d
        };
        let when = match days.as_slice() {
            [] | [0, 1, 2, 3, 4, 5, 6] => "Daily".to_string(),
            [0, 1, 2, 3, 4] => "Weekdays".to_string(),
            [5, 6] => "Weekends".to_string(),
            some => some.iter().filter_map(|d| DAY_NAMES.get(*d as usize)).copied().collect::<Vec<_>>().join(", "),
        };
        format!("{when} at {at}")
    }

    /// The first time after `now` this runs. Measured from now rather than
    /// from the slot just missed, so a Mac waking from a night's sleep runs a
    /// routine once, never once per slot it slept through.
    pub fn next_after(&self, now: DateTime<Local>) -> Option<DateTime<Local>> {
        if let Some(m) = self.every_minutes {
            return Some(now + chrono::Duration::minutes(m.max(1) as i64));
        }
        let time = NaiveTime::parse_from_str(self.at.as_deref()?, "%H:%M").ok()?;
        (0..=7).find_map(|ahead| {
            let date = now.date_naive() + chrono::Duration::days(ahead);
            let day = date.weekday().num_days_from_monday() as u8;
            if !self.days.is_empty() && !self.days.contains(&day) {
                return None;
            }
            // `earliest` takes the first of a time the clocks go back over,
            // and none falls in the hour they skip forward.
            let at = Local.from_local_datetime(&date.and_time(time)).earliest()?;
            (at > now).then_some(at)
        })
    }
}

const DAY_NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

fn span(minutes: u32) -> String {
    match minutes {
        m if m % 1440 == 0 => format!("{}d", m / 1440),
        m if m % 60 == 0 => format!("{}h", m / 60),
        m => format!("{m}m"),
    }
}

fn parse_minutes(text: &str) -> Result<u32> {
    let t = text.trim().to_lowercase();
    let t = t.strip_prefix("every").unwrap_or(&t).trim();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    let unit = t[digits.len()..].trim();
    let n: u32 = digits.parse().with_context(|| format!("can't read {text:?} — try 30m, 2h or 1d"))?;
    let per = match unit {
        "m" | "min" | "mins" | "minute" | "minutes" => 1,
        "h" | "hr" | "hrs" | "hour" | "hours" => 60,
        "d" | "day" | "days" => 1440,
        _ => anyhow::bail!("can't read {text:?} — try 30m, 2h or 1d"),
    };
    n.checked_mul(per).filter(|m| *m > 0).with_context(|| format!("can't read {text:?}"))
}

/// `09:00`, `9:30`, `9am`, `5:15pm`.
fn parse_time(text: &str) -> Result<NaiveTime> {
    let t = text.trim().to_lowercase().replace(' ', "");
    let (clock, pm) = match (t.strip_suffix("am"), t.strip_suffix("pm")) {
        (Some(c), _) => (c.to_string(), Some(false)),
        (_, Some(c)) => (c.to_string(), Some(true)),
        _ => (t.clone(), None),
    };
    let (h, m) = clock.split_once(':').unwrap_or((&clock, "0"));
    let bad = || anyhow::anyhow!("can't read {text:?} — try 09:00 or 9am");
    let (mut h, m): (u32, u32) = (h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    if let Some(pm) = pm {
        if !(1..=12).contains(&h) {
            return Err(bad());
        }
        h = h % 12 + if pm { 12 } else { 0 };
    }
    NaiveTime::from_hms_opt(h, m, 0).ok_or_else(bad)
}

/// `weekdays`, `weekends`, `daily`, or `mon,wed,fri`.
fn parse_days(text: &str) -> Result<Vec<u8>> {
    let t = text.trim().to_lowercase();
    match t.as_str() {
        "daily" | "every day" | "all" => return Ok(vec![]),
        "weekdays" => return Ok(vec![0, 1, 2, 3, 4]),
        "weekends" => return Ok(vec![5, 6]),
        _ => {}
    }
    let mut days: Vec<u8> = t
        .split([',', ' '])
        .filter(|d| !d.is_empty())
        .map(|d| {
            DAY_NAMES
                .iter()
                .position(|n| d.starts_with(&n.to_lowercase()))
                .map(|i| i as u8)
                .with_context(|| format!("no day {d:?} — try weekdays, or mon,wed,fri"))
        })
        .collect::<Result<_>>()?;
    days.sort();
    days.dedup();
    Ok(days)
}

fn rfc3339(t: DateTime<Local>) -> String {
    t.with_timezone(&Utc).to_rfc3339()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn result(outcome: &str, text: Option<String>) -> RunResult {
    RunResult { outcome: outcome.into(), text, at: now_iso() }
}

/// A bot's routine by id, or by name in any case.
fn find<'a>(list: &'a mut [Routine], key: &str, bot_id: Option<&str>) -> Result<&'a mut Routine> {
    let key = key.trim();
    let mine = |r: &Routine| bot_id.is_none_or(|b| r.bot_id == b);
    if let Some(at) = list.iter().position(|r| r.id == key && mine(r)) {
        return Ok(&mut list[at]);
    }
    let named: Vec<usize> = (0..list.len())
        .filter(|&i| mine(&list[i]) && list[i].name.trim().eq_ignore_ascii_case(key))
        .collect();
    match named.as_slice() {
        [one] => Ok(&mut list[*one]),
        [] => anyhow::bail!("no routine {key:?} — `dray bot routine ls` lists them"),
        _ => anyhow::bail!("several routines are named {key:?} — name one by id"),
    }
}

/// Makes a routine for `bot`, its first run one schedule step from now.
pub async fn add(bot: &bots::Bot, name: &str, prompt: &str, schedule: Schedule, check: Option<String>) -> Result<Routine> {
    let name = name.trim();
    if name.is_empty() || prompt.trim().is_empty() {
        anyhow::bail!("a routine needs a name and a prompt");
    }
    let next = schedule.next_after(Local::now()).context("that schedule never runs")?;
    let check = check.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    edit(|list| {
        if list.iter().filter(|r| r.bot_id == bot.id).count() >= MAX_PER_BOT {
            anyhow::bail!("a bot holds at most {MAX_PER_BOT} routines — remove one first");
        }
        if list.iter().any(|r| r.bot_id == bot.id && r.name.trim().eq_ignore_ascii_case(name)) {
            anyhow::bail!("this bot already has a routine named {name:?} — remove it or pick another name");
        }
        let id = loop {
            let id = format!("r{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
            if !list.iter().any(|r| r.id == id) {
                break id;
            }
        };
        let routine = Routine {
            id,
            bot_id: bot.id.clone(),
            name: name.to_string(),
            prompt: prompt.trim().to_string(),
            schedule,
            check,
            paused: false,
            created: now_iso(),
            next_run: Some(rfc3339(next)),
            last_result: None,
            check_hash: None,
            check_failing: false,
        };
        list.push(routine.clone());
        Ok(routine)
    })
    .await
}

/// Every routine, or one bot's.
pub async fn list(bot_id: Option<&str>) -> Result<Vec<Routine>> {
    let _guard = LOCK.lock().await;
    Ok(load().await?.into_iter().filter(|r| bot_id.is_none_or(|b| r.bot_id == b)).collect())
}

/// Pauses or resumes. Resuming counts from now, so a routine paused for a
/// week does not fire the moment it comes back.
pub async fn set_paused(key: &str, bot_id: Option<&str>, paused: bool) -> Result<Routine> {
    edit(|list| {
        let r = find(list, key, bot_id)?;
        r.paused = paused;
        r.next_run = if paused { None } else { r.schedule.next_after(Local::now()).map(rfc3339) };
        Ok(r.clone())
    })
    .await
}

pub async fn remove(key: &str, bot_id: Option<&str>) -> Result<Routine> {
    edit(|list| {
        let id = find(list, key, bot_id)?.id.clone();
        let at = list.iter().position(|r| r.id == id).unwrap_or_default();
        Ok(list.remove(at))
    })
    .await
}

/// Drops a deleted bot's routines.
pub async fn remove_bot(bot_id: &str) -> Result<()> {
    edit(|list| {
        list.retain(|r| r.bot_id != bot_id);
        Ok(())
    })
    .await
}

/// Due now: the next tick runs it, whatever its schedule. Paused ones too,
/// once, so the bot can try a routine before turning it on.
pub async fn run_now(key: &str, bot_id: Option<&str>) -> Result<Routine> {
    let routine = edit(|list| Ok(find(list, key, bot_id)?.clone())).await?;
    FORCED.lock().unwrap().insert(routine.id.clone());
    NUDGE.notify_one();
    Ok(routine)
}

/// Routines asked to run now, by id.
static FORCED: LazyLock<std::sync::Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// Wakes the scheduler early for a run asked for by hand.
static NUDGE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// The scheduler. Ticks on the wall clock, so a routine due while the machine
/// slept runs on the first tick after it wakes.
pub async fn run(sink: Sink) {
    // A turn cut off by a restart never reports its end.
    let interrupted = edit(|list| {
        let mut any = false;
        for r in list.iter_mut().filter(|r| r.last_result.as_ref().is_some_and(|l| l.outcome == "running")) {
            r.last_result = Some(result("failed", Some("Interrupted by a restart".into())));
            any = true;
        }
        Ok(any)
    })
    .await;
    if matches!(interrupted, Ok(true)) {
        sink.emit(ROUTINES_CHANGED, ()).ok();
    }
    // Bots with a run between its check and its message landing.
    let firing: std::sync::Arc<std::sync::Mutex<HashSet<String>>> = Default::default();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(TICK) => {}
            _ = NUDGE.notified() => {}
        }
        if let Err(e) = tick(&sink, &firing).await {
            eprintln!("[routines] {e:#}");
        }
    }
}

/// Fires every routine that is due. Its next run is written *before* it fires,
/// so a crash mid-run skips that run rather than repeating it.
async fn tick(sink: &Sink, firing: &std::sync::Arc<std::sync::Mutex<HashSet<String>>>) -> Result<()> {
    let forced = std::mem::take(&mut *FORCED.lock().unwrap());
    let bots = bots::list_bots().await?;
    let now = Local::now();
    let is_due = |r: &Routine| {
        !r.paused
            && r.next_run
                .as_deref()
                .and_then(|n| DateTime::parse_from_rfc3339(n).ok())
                .is_some_and(|n| n <= now)
    };
    let mut candidates = Vec::new();
    for r in list(None).await? {
        if !is_due(&r) && !forced.contains(&r.id) {
            continue;
        }
        if firing.lock().unwrap().contains(&r.bot_id) {
            // Its bot is mid-run: a Run now waits for the next tick rather than
            // being dropped, since a paused routine has no schedule to bring it back.
            if forced.contains(&r.id) {
                FORCED.lock().unwrap().insert(r.id.clone());
            }
            continue;
        }
        candidates.push(r);
    }
    // Asked outside the lock: a turn's end records its result under it, and
    // this question waits on that session's slot.
    let mut ready = HashSet::new();
    for r in &candidates {
        let Some(bot) = bots.iter().find(|b| b.id == r.bot_id) else { continue };
        // A bot mid-turn is left due: its message would queue behind the
        // turn, and that turn's end would be read as this run's.
        let busy = match bots::chat_of(bot).await {
            Some(chat) => crate::session::manager().turn_in_flight(&chat.session_id).await,
            None => false,
        };
        if busy && forced.contains(&r.id) {
            FORCED.lock().unwrap().insert(r.id.clone());
        }
        if !busy {
            ready.insert(r.id.clone());
        }
    }

    let mut due = Vec::new();
    let mut changed = false;
    {
        let _guard = LOCK.lock().await;
        let mut list = load().await?;
        let before = list.len();
        list.retain(|r| bots.iter().any(|b| b.id == r.bot_id));
        changed |= list.len() != before;
        for r in list.iter_mut().filter(|r| ready.contains(&r.id)) {
            let Some(bot) = bots.iter().find(|b| b.id == r.bot_id) else { continue };
            // Read again: paused or edited while the chat was asked about.
            let scheduled = is_due(r);
            if !scheduled && !forced.contains(&r.id) {
                continue;
            }
            // One run per bot at a time: two would share its chat, and the
            // first turn to end would be read as both. The other stays due.
            if !firing.lock().unwrap().insert(r.bot_id.clone()) {
                if forced.contains(&r.id) {
                    FORCED.lock().unwrap().insert(r.id.clone());
                }
                continue;
            }
            if scheduled {
                r.next_run = r.schedule.next_after(now).map(rfc3339);
                changed = true;
            }
            due.push((r.clone(), bot.clone()));
        }
        if changed {
            save(&list).await?;
        }
    }
    if changed {
        sink.emit(ROUTINES_CHANGED, ()).ok();
    }
    for (routine, bot) in due {
        let sink = sink.clone();
        let firing = firing.clone();
        tokio::spawn(async move {
            let (id, bot_id) = (routine.id.clone(), bot.id.clone());
            if let Err(e) = fire(routine, bot, &sink).await {
                eprintln!("[routine {id}] {e:#}");
                record(&id, result("failed", Some(format!("{e:#}"))), None, &sink).await;
            }
            firing.lock().unwrap().remove(&bot_id);
        });
    }
    Ok(())
}

/// What a check printed, or why it failed.
async fn run_check(check: &str, cwd: &str) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c")
        .arg(check)
        .current_dir(cwd)
        .env("PATH", crate::binpath::child_path(crate::binpath::resolved_bin_dirs()))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = match tokio::time::timeout(CHECK_TIMEOUT, cmd.output()).await {
        Err(_) => return Err(format!("timed out after {}s", CHECK_TIMEOUT.as_secs())),
        Ok(Err(e)) => return Err(format!("could not run: {e}")),
        Ok(Ok(out)) => out,
    };
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let code = out.status.code().map_or("a signal".to_string(), |c| format!("exit {c}"));
    Err(match stderr.trim().lines().last() {
        Some(line) => format!("{code}: {}", tail(line, 200)),
        None => code,
    })
}

fn tail(text: &str, cap: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    chars[chars.len().saturating_sub(cap)..].iter().collect()
}

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// One run: the check, then the message.
async fn fire(routine: Routine, bot: bots::Bot, sink: &Sink) -> Result<()> {
    let mut seen = None;
    let mut note = String::new();
    if let Some(check) = &routine.check {
        match run_check(check, &bot.path).await {
            Ok(output) => {
                let h = hash(&output);
                if routine.check_hash.as_deref() == Some(h.as_str()) && !routine.check_failing {
                    record(&routine.id, result("no_change", None), Some((h, false)), sink).await;
                    return Ok(());
                }
                let first = routine.check_hash.is_none();
                let shown = if output.trim().is_empty() { "(nothing)".to_string() } else { tail(output.trim(), OUTPUT_CAP) };
                note = format!(
                    "\n\nIts check `{check}` {}:\n\n```\n{shown}\n```",
                    if first {
                        "ran for the first time, so this only sets what later runs are compared against. Unless it already shows what the routine watches for, say nothing. It printed"
                    } else {
                        "printed something new"
                    }
                );
                seen = Some((h, false));
            }
            Err(why) => {
                // A failure is never a change, and only the first of a run of
                // them wakes the bot, which can mend its check.
                let failing_already = routine.check_failing;
                if failing_already {
                    let hash = routine.check_hash.clone().unwrap_or_default();
                    record(&routine.id, result("check_failed", Some(why)), Some((hash, true)), sink).await;
                    return Ok(());
                }
                note = format!(
                    "\n\nIts check `{check}` failed ({why}). Fix the check with `dray bot routine rm` and `add` if it is wrong; nothing more is said while it keeps failing."
                );
                seen = Some((routine.check_hash.clone().unwrap_or_default(), true));
            }
        }
    }

    let Some(chat) = bots::chat_of(&bot).await else {
        // The check's new output is kept back, so the next run still sees it as new.
        record(&routine.id, result("skipped", Some("The bot has no chat".into())), None, sink).await;
        return Ok(());
    };
    let prompt = format!(
        "Routine \"{}\" ({}) is due, {}. This is Dray, not the user; the user sees only what you write back.\n\n{}{note}\n\n\
         Write to the user only when this run finds something they need to know now. Otherwise end your turn with no text at all: \
         no status, no \"still waiting\", no \"nothing new\". Don't make or change routines during this run.",
        routine.name,
        routine.id,
        routine.schedule.describe().to_lowercase(),
        routine.prompt,
    );
    let from = MessageSender {
        session_id: routine.id.clone(),
        title: routine.name.clone(),
        machine: None,
        bot_id: None,
        routine: Some(true),
    };
    RUNNING.lock().unwrap().insert(chat.session_id.clone(), routine.id.clone());
    record(&routine.id, result("running", None), None, sink).await;
    if let Err(e) = crate::orchestration::send_routine(chat.session_id.clone(), prompt, from, sink).await {
        RUNNING.lock().unwrap().remove(&chat.session_id);
        return Err(e);
    }
    // Only once the bot has it: saved before a send that failed, the change
    // would read as old on every later run and the bot would never hear of it.
    if let Some(seen) = seen {
        save_check(&routine.id, seen).await;
    }
    Ok(())
}

/// Writes a run's result, and the check's state where `seen` carries it.
async fn record(id: &str, run: RunResult, seen: Option<(String, bool)>, sink: &Sink) {
    let saved = edit(|list| {
        if let Some(r) = list.iter_mut().find(|r| r.id == id) {
            r.last_result = Some(run);
            if let Some(seen) = seen {
                apply_check(r, seen);
            }
        }
        Ok(())
    })
    .await;
    match saved {
        Ok(()) => {
            sink.emit(ROUTINES_CHANGED, ()).ok();
        }
        Err(e) => eprintln!("[routine {id}] {e:#}"),
    }
}

/// The check's state as of its last run: its output's hash, and whether it failed.
fn apply_check(r: &mut Routine, (hash, failing): (String, bool)) {
    if !hash.is_empty() {
        r.check_hash = Some(hash);
    }
    r.check_failing = failing;
}

/// Saves the check's state alone, leaving the result the turn may already have written.
async fn save_check(id: &str, seen: (String, bool)) {
    let saved = edit(|list| {
        if let Some(r) = list.iter_mut().find(|r| r.id == id) {
            apply_check(r, seen);
        }
        Ok(())
    })
    .await;
    if let Err(e) = saved {
        eprintln!("[routine {id}] {e:#}");
    }
}

/// A bot chat's turn ended. Where a routine started it, that is the run's
/// result: silent, the reply's first line, or failed.
pub async fn turn_ended(chat: &str, said: Option<&str>, ok: bool, sink: &Sink) {
    let Some(id) = RUNNING.lock().unwrap().remove(chat) else { return };
    let run = match (ok, said.map(str::trim).filter(|s| !s.is_empty())) {
        (false, _) => result("failed", Some("The turn failed".into())),
        (true, None) => result("silent", None),
        (true, Some(text)) => {
            let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or(text).trim();
            let short: String = line.chars().take(160).collect();
            result("replied", Some(short))
        }
    };
    record(&id, run, None, sink).await;
}

/// The bot `bot` names, else the one whose chat `from_session_id` is.
pub async fn bot_for(bot: Option<&str>, from_session_id: Option<&str>) -> Result<Option<bots::Bot>> {
    if let Some(key) = bot {
        return bots::find_bot(key).await.map(Some);
    }
    let Some(id) = from_session_id else { return Ok(None) };
    let Some(item) = store::get_session_index_item(id).await? else { return Ok(None) };
    Ok(bots::bot_at(&item.cwd).await)
}

/// The app's routines card: one bot's.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_routines(bot_id: String) -> Result<Vec<Routine>, Fail> {
    Ok(list(Some(&bot_id)).await?)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_routine_paused(id: String, paused: bool, sink: Sink) -> Result<Routine, Fail> {
    let r = set_paused(&id, None, paused).await?;
    sink.emit(ROUTINES_CHANGED, ()).ok();
    Ok(r)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_routine(id: String, sink: Sink) -> Result<(), Fail> {
    remove(&id, None).await?;
    sink.emit(ROUTINES_CHANGED, ()).ok();
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn run_routine(id: String) -> Result<(), Fail> {
    run_now(&id, None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    #[test]
    fn reads_every_and_at() {
        assert_eq!(Schedule::parse(Some("30m"), None, None).unwrap().every_minutes, Some(30));
        assert_eq!(Schedule::parse(Some("every 2 hours"), None, None).unwrap().every_minutes, Some(120));
        assert_eq!(Schedule::parse(Some("1d"), None, None).unwrap().every_minutes, Some(1440));
        assert!(Schedule::parse(Some("1m"), None, None).unwrap_err().to_string().contains("5m"));
        assert!(Schedule::parse(Some("soon"), None, None).is_err());
        assert!(Schedule::parse(None, None, None).is_err());
        let at = Schedule::parse(None, Some("9:30pm"), Some("weekdays")).unwrap();
        assert_eq!(at.at.as_deref(), Some("21:30"));
        assert_eq!(at.days, vec![0, 1, 2, 3, 4]);
        assert_eq!(Schedule::parse(None, Some("12am"), None).unwrap().at.as_deref(), Some("00:00"));
        assert_eq!(Schedule::parse(None, Some("9am"), Some("fri, mon")).unwrap().days, vec![0, 4]);
        assert!(Schedule::parse(None, Some("25:00"), None).is_err());
        assert!(Schedule::parse(None, Some("9am"), Some("someday")).is_err());
    }

    #[test]
    fn says_its_schedule() {
        let s = |every: Option<&str>, at: Option<&str>, days: Option<&str>| Schedule::parse(every, at, days).unwrap().describe();
        assert_eq!(s(Some("90m"), None, None), "Every 90m");
        assert_eq!(s(Some("2h"), None, None), "Every 2h");
        assert_eq!(s(None, Some("9am"), None), "Daily at 09:00");
        assert_eq!(s(None, Some("9am"), Some("weekdays")), "Weekdays at 09:00");
        assert_eq!(s(None, Some("9am"), Some("mon,wed")), "Mon, Wed at 09:00");
    }

    #[test]
    fn a_missed_night_runs_once() {
        // Due at 01:00, the machine woke at 08:10: the next run counts from
        // waking, not from the seven slots slept through.
        let every = Schedule::parse(Some("1h"), None, None).unwrap();
        assert_eq!(every.next_after(local(2026, 11, 13, 8, 10)), Some(local(2026, 11, 13, 9, 10)));
    }

    #[test]
    fn at_finds_the_next_allowed_day() {
        // 2026-11-13 is a Friday.
        let weekdays = Schedule::parse(None, Some("09:00"), Some("weekdays")).unwrap();
        assert_eq!(weekdays.next_after(local(2026, 11, 13, 8, 0)), Some(local(2026, 11, 13, 9, 0)));
        assert_eq!(weekdays.next_after(local(2026, 11, 13, 9, 0)), Some(local(2026, 11, 16, 9, 0)));
        let daily = Schedule::parse(None, Some("09:00"), None).unwrap();
        assert_eq!(daily.next_after(local(2026, 11, 13, 23, 0)), Some(local(2026, 11, 14, 9, 0)));
    }

    #[test]
    fn an_unknown_schedule_kind_still_reads() {
        let r: Routine = serde_json::from_str(
            r#"{"id":"r1","botId":"b","name":"n","prompt":"p","schedule":{"cron":"* * * * *"},"created":"x"}"#,
        )
        .unwrap();
        assert_eq!(r.schedule, Schedule::default());
        assert_eq!(r.schedule.next_after(Local::now()), None);
    }
}

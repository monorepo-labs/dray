//! Bots talking to each other (#1303): the exchange a message belongs to, the
//! guards that stop two bots messaging each other forever, and passing an
//! `--ask`'s answer back to the bot that asked.
//!
//! A chain is a run of bot messages each sent from a turn another bot's
//! message started. The server numbers it, never the model, so no bot can
//! reset it; anyone else's message to a bot — the user's above all — ends it.
//! Held in memory: a restart ends every turn, and a chain lives inside turns.

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::events::MessageSender;
use crate::sink::Sink;

/// Messages one chain may carry. Hermes's default; an exchange needing more
/// is one the user should hear about.
pub const MAX_HOPS: u32 = 4;
/// Messages between one pair of bots, either way, inside [`WINDOW`]. Catches a
/// loop the chain cannot see, such as one a task's report restarts.
const WINDOW_SENDS: usize = 20;
const WINDOW: Duration = Duration::from_secs(5 * 60);
/// How long a chain's messages are kept for the repeat check.
const CHAIN_LIFE: Duration = Duration::from_secs(60 * 60);

/// The chain each session's turn belongs to, and how deep: set as a bot's
/// message reaches its child, dropped as anyone else's does.
static CURRENT: LazyLock<Mutex<HashMap<String, (String, u32)>>> = LazyLock::new(Default::default);
/// Asks a session's child has been given and whose turn has not ended.
static ASKS: LazyLock<Mutex<HashMap<String, Vec<Ask>>>> = LazyLock::new(Default::default);
/// Per chain, what was sent to whom, for the repeat check.
static SENT: LazyLock<Mutex<HashMap<String, (Instant, HashSet<(String, u64)>)>>> = LazyLock::new(Default::default);
/// Per pair of bots, when each message between them went.
static PAIRS: LazyLock<Mutex<HashMap<(String, String), VecDeque<Instant>>>> = LazyLock::new(Default::default);

/// An `--ask` waiting on the end of the turn it reached.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    /// The bot that asked, where the answer goes.
    pub bot_id: String,
    pub chain: String,
    pub hop: u32,
}

/// Why a bot's message was not sent.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    TooDeep,
    Repeated,
    TooFast,
}

impl Refusal {
    /// What the sending bot reads, as its command's error.
    pub fn to_bot(&self, to: &str) -> String {
        match self {
            Refusal::TooDeep => format!(
                "not sent: this exchange between bots is already {MAX_HOPS} messages deep, Dray's limit. Stop \
                 messaging and tell the user what is still open; their next message starts a new exchange."
            ),
            Refusal::Repeated => format!("not sent: you already sent \"{to}\" this same message in this exchange."),
            Refusal::TooFast => format!(
                "not sent: {WINDOW_SENDS} messages between you and \"{to}\" in 5 minutes, Dray's limit. Stop \
                 messaging \"{to}\" and tell the user what is still open."
            ),
        }
    }

    /// The line the user sees in the sending bot's chat. A repeat is the bot's
    /// own slip, told to it alone.
    pub fn notice(&self, from: &str, to: &str) -> Option<String> {
        match self {
            Refusal::TooDeep => Some(format!(
                "Dray stopped {from} messaging {to}: they had gone back and forth {MAX_HOPS} times. A message from you starts fresh."
            )),
            Refusal::TooFast => {
                Some(format!("Dray stopped {from} messaging {to}: {WINDOW_SENDS} messages between them in 5 minutes."))
            }
            Refusal::Repeated => None,
        }
    }
}

/// The chain and hop a bot's message from `session_id` carries: one deeper
/// into the chain its turn belongs to, else the first of a new one.
pub fn next_hop(session_id: &str) -> (String, u32) {
    match CURRENT.lock().unwrap().get(session_id) {
        Some((chain, hop)) => (chain.clone(), hop + 1),
        None => (uuid::Uuid::now_v7().to_string(), 1),
    }
}

/// Checks a message from bot `from` to bot `to` against every guard, and
/// counts it where it passes.
pub fn admit(from: &str, to: &str, chain: &str, hop: u32, text: &str) -> Result<(), Refusal> {
    admit_at(Instant::now(), from, to, chain, hop, text)
}

fn admit_at(now: Instant, from: &str, to: &str, chain: &str, hop: u32, text: &str) -> Result<(), Refusal> {
    if hop > MAX_HOPS {
        return Err(Refusal::TooDeep);
    }
    let key = (to.to_string(), text_hash(text));
    let mut sent = SENT.lock().unwrap();
    sent.retain(|_, (at, _)| now.duration_since(*at) < CHAIN_LIFE);
    if sent.get(chain).is_some_and(|(_, seen)| seen.contains(&key)) {
        return Err(Refusal::Repeated);
    }
    let mut pairs = PAIRS.lock().unwrap();
    let times = pairs.entry(pair(from, to)).or_default();
    while times.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
        times.pop_front();
    }
    if times.len() >= WINDOW_SENDS {
        return Err(Refusal::TooFast);
    }
    times.push_back(now);
    let entry = sent.entry(chain.to_string()).or_insert_with(|| (now, HashSet::new()));
    entry.0 = now;
    entry.1.insert(key);
    Ok(())
}

/// Counts a passed-back answer against the pair's window. Never refused: the
/// asker is waiting on it, and it asks nothing of anyone.
fn count_reply(from: &str, to: &str) {
    let mut pairs = PAIRS.lock().unwrap();
    pairs.entry(pair(from, to)).or_default().push_back(Instant::now());
}

/// `session_id` answered the bot `to` with a message of its own, so an ask
/// from that bot needs nothing passed back.
pub fn answered(session_id: &str, to: &str) {
    if let Some(asks) = ASKS.lock().unwrap().get_mut(session_id) {
        asks.retain(|a| a.bot_id != to);
    }
}

/// A prompt from `from` reaching `session_id`'s child: the turn it joins now
/// belongs to that message's chain, or to none.
pub fn delivered(session_id: &str, from: Option<&MessageSender>) {
    let bot_message = from.and_then(|f| Some((f.bot_id.as_ref()?, f.chain.as_ref()?, f.hop?, f.ask == Some(true))));
    let Some((bot_id, chain, hop, ask)) = bot_message else {
        CURRENT.lock().unwrap().remove(session_id);
        return;
    };
    CURRENT.lock().unwrap().insert(session_id.to_string(), (chain.clone(), hop));
    if ask {
        let ask = Ask { bot_id: bot_id.clone(), chain: chain.clone(), hop };
        ASKS.lock().unwrap().entry(session_id.to_string()).or_default().push(ask);
    }
}

/// The asks `session_id`'s ending turn answers, taken once.
pub fn take_asks(session_id: &str) -> Vec<Ask> {
    ASKS.lock().unwrap().remove(session_id).unwrap_or_default()
}

/// Passes `text`, the last words of `session_id`'s turn, back to each bot in
/// `asks`, as a reply from the bot that turn ran. Boxed for the reason
/// `report_to_parent` is: the send can reach the harness's `init` again.
pub fn pass_back(
    session_id: String,
    asks: Vec<Ask>,
    text: String,
    app: Sink,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send>> {
    Box::pin(async move {
        let Some(item) = crate::store::get_session_index_item(&session_id).await? else { return Ok(()) };
        let Some(replier) = super::bot_at(&item.cwd).await else { return Ok(()) };
        for ask in asks {
            let Ok(asker) = super::find_bot(&ask.bot_id).await else { continue };
            let Some(chat) = super::chat_of(&asker).await else { continue };
            count_reply(&replier.id, &asker.id);
            let from = MessageSender {
                session_id: session_id.clone(),
                title: replier.name.clone(),
                bot_id: Some(replier.id.clone()),
                chain: Some(ask.chain),
                hop: Some(ask.hop + 1),
                reply: Some(true),
                ..Default::default()
            };
            crate::orchestration::deliver_report(chat.session_id, text.clone(), from, app.clone()).await?;
        }
        Ok(())
    })
}

/// Either order names the same pair, so a loop counts both directions.
fn pair(a: &str, b: &str) -> (String, String) {
    if a <= b { (a.to_string(), b.to_string()) } else { (b.to_string(), a.to_string()) }
}

fn text_hash(text: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.trim().hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot_message(chain: &str, hop: u32, ask: bool) -> MessageSender {
        MessageSender {
            session_id: "s".into(),
            title: "Ops".into(),
            bot_id: Some("ops".into()),
            chain: Some(chain.into()),
            hop: Some(hop),
            ask: ask.then_some(true),
            ..Default::default()
        }
    }

    #[test]
    fn a_chain_deepens_with_each_bot_message_and_ends_with_anyone_elses() {
        let (chain, hop) = next_hop("t-deepen");
        assert_eq!(hop, 1);
        delivered("t-deepen", Some(&bot_message(&chain, 3, false)));
        assert_eq!(next_hop("t-deepen"), (chain.clone(), 4));
        // The user writes: the next send opens a new exchange.
        delivered("t-deepen", None);
        let (fresh, hop) = next_hop("t-deepen");
        assert_ne!(fresh, chain);
        assert_eq!(hop, 1);
    }

    #[test]
    fn the_fifth_message_of_a_chain_is_refused() {
        for hop in 1..=MAX_HOPS {
            assert_eq!(admit("deep-a", "deep-b", "deep", hop, &format!("m{hop}")), Ok(()));
        }
        assert_eq!(admit("deep-b", "deep-a", "deep", MAX_HOPS + 1, "m5"), Err(Refusal::TooDeep));
    }

    #[test]
    fn the_same_message_twice_in_a_chain_is_refused() {
        assert_eq!(admit("rep-a", "rep-b", "rep", 1, "status?"), Ok(()));
        assert_eq!(admit("rep-a", "rep-b", "rep", 2, " status? "), Err(Refusal::Repeated));
        // To someone else, or in another exchange, it goes.
        assert_eq!(admit("rep-a", "rep-c", "rep", 2, "status?"), Ok(()));
        assert_eq!(admit("rep-a", "rep-b", "rep-2", 1, "status?"), Ok(()));
    }

    #[test]
    fn a_pair_is_held_to_its_window_both_ways() {
        let start = Instant::now();
        for i in 0..WINDOW_SENDS {
            let (from, to) = if i % 2 == 0 { ("win-a", "win-b") } else { ("win-b", "win-a") };
            assert_eq!(admit_at(start, from, to, &format!("w{i}"), 1, "x"), Ok(()));
        }
        assert_eq!(admit_at(start, "win-a", "win-b", "w-over", 1, "x"), Err(Refusal::TooFast));
        // Another pair is untouched, and the window moves on.
        assert_eq!(admit_at(start, "win-a", "win-c", "w-other", 1, "x"), Ok(()));
        assert_eq!(admit_at(start + WINDOW, "win-a", "win-b", "w-later", 1, "x"), Ok(()));
    }

    #[test]
    fn an_ask_waits_for_its_turn_to_end_unless_answered_by_hand() {
        delivered("t-ask", Some(&bot_message("c", 1, true)));
        assert_eq!(take_asks("t-ask"), vec![Ask { bot_id: "ops".into(), chain: "c".into(), hop: 1 }]);
        assert!(take_asks("t-ask").is_empty());

        delivered("t-ask", Some(&bot_message("c", 1, true)));
        answered("t-ask", "ops");
        assert!(take_asks("t-ask").is_empty());
    }
}

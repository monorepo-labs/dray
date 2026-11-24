//! `dray --machine <name> bot send --ask` (#1463): a bot on another machine
//! answering a session here.
//!
//! The question goes out over this server's link to the bot's machine, and
//! reach follows tokens: the bot's server usually holds none for this one. So
//! the bot's server keeps the answer, and this one collects it over the link
//! the question went out on, the way a far task's reports come back (#958).
//!
//! Two files, one per side. `bot-answers.json` on the bot's server holds each
//! question from another machine and, once the bot's turn ends, its answer;
//! `remote-asks.json` on the asking server holds which questions to collect.
//!
//! An answer is delivered at most once: the asking side marks a question
//! delivered on disk before it sends the answer on, and never asks for a
//! delivered one again. It is acked after, and a lost ack costs a repeat ack.

use crate::store;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// How long the bot's server keeps a question, answered or not, for the
/// asking server to collect. A server that removed this machine, or never
/// came back, says nothing, so nothing else clears it.
const KEEP_FOR: u64 = 7 * 24 * 60 * 60;

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// A question from another machine to a bot here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// Minted by the asking server, which collects by it.
    pub id: String,
    pub bot_id: String,
    /// Who asked and from where, for a notice when the answer cannot land.
    pub asker: String,
    #[serde(default)]
    pub machine: Option<String>,
    /// When this server took it, on this server's clock.
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Answer>,
}

/// The bot's answer: its turn's last words, signed by the bot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// The bot chat's session that answered, the address to write back to.
    pub session_id: String,
    /// The bot's name.
    pub title: String,
    pub bot_id: String,
    pub text: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Inbox {
    #[serde(default)]
    questions: Vec<Question>,
}

/// What the serve command `bot_answers` answers.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Collected {
    /// Answers to the questions asked about, by question id.
    pub answers: Vec<(String, Answer)>,
    /// Questions asked about that this server no longer holds: lost to a
    /// restart before the bot answered, or kept past [`KEEP_FOR`].
    pub gone: Vec<String>,
}

/// One file, rewritten whole by every bot turn and every collect.
static INBOX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn inbox_path() -> anyhow::Result<PathBuf> {
    Ok(store::get_home_app_dir().await?.join("bot-answers.json"))
}

async fn save_inbox(inbox: &Inbox) -> anyhow::Result<()> {
    store::write_atomic(&inbox_path().await?, serde_json::to_string_pretty(inbox)?).await
}

/// Takes a question from another machine for `bot_id`, before the message
/// reaches the bot, so its answer always has a place to land.
pub async fn expect(id: &str, bot_id: &str, asker: &str, machine: Option<&str>) -> anyhow::Result<()> {
    let _guard = INBOX.lock().await;
    let mut inbox: Inbox = store::read_json(&inbox_path().await?).await?;
    inbox.questions.retain(|q| q.id != id);
    inbox.questions.push(Question {
        id: id.to_string(),
        bot_id: bot_id.to_string(),
        asker: asker.to_string(),
        machine: machine.map(str::to_string),
        at: now(),
        answer: None,
    });
    save_inbox(&inbox).await
}

/// Takes back a question whose message never reached the bot.
pub async fn unexpect(id: &str) {
    let _guard = INBOX.lock().await;
    let dropped = async {
        let mut inbox: Inbox = store::read_json(&inbox_path().await?).await?;
        inbox.questions.retain(|q| q.id != id);
        save_inbox(&inbox).await
    };
    if let Err(e) = dropped.await {
        eprintln!("[remote asks err] {e:#}");
    }
}

/// Files the bot's answer to question `id` for the asking server to collect.
/// A question already gone — expired, or dropped at a restart — takes none.
pub async fn answer(id: &str, answer: Answer) -> anyhow::Result<()> {
    let _guard = INBOX.lock().await;
    let mut inbox: Inbox = store::read_json(&inbox_path().await?).await?;
    let Some(question) = inbox.questions.iter_mut().find(|q| q.id == id) else { return Ok(()) };
    question.answer = Some(answer);
    save_inbox(&inbox).await
}

/// At start: a restart ended every turn, so a question still unanswered will
/// never be. Dropped, the asking server hears it is gone on its next collect.
pub async fn forget_unanswered() {
    let _guard = INBOX.lock().await;
    let dropped = async {
        let mut inbox: Inbox = store::read_json(&inbox_path().await?).await?;
        let before = inbox.questions.len();
        inbox.questions.retain(|q| q.answer.is_some());
        if inbox.questions.len() != before {
            save_inbox(&inbox).await?;
        }
        anyhow::Ok(())
    };
    if let Err(e) = dropped.await {
        eprintln!("[remote asks err] {e:#}");
    }
}

/// The serve command `bot_answers`: drops the questions `ack` names, and those
/// `undelivered` names with a line in the bot's chat saying its answer did not
/// land, then answers what `asks` is waiting on.
#[cfg(any(feature = "serve", feature = "desktop"))]
pub async fn take(
    asks: Vec<String>,
    ack: Vec<String>,
    undelivered: Vec<String>,
    sink: &crate::sink::Sink,
) -> Result<Collected, String> {
    let guard = INBOX.lock().await;
    let path = inbox_path().await.map_err(|e| format!("{e:#}"))?;
    let mut inbox: Inbox = store::read_json(&path).await.map_err(|e| format!("{e:#}"))?;
    let before = inbox.questions.len();
    let (collected, unlanded) = inbox.take(&asks, &ack, &undelivered, now());
    if inbox.questions.len() != before {
        save_inbox(&inbox).await.map_err(|e| format!("{e:#}"))?;
    }
    drop(guard);
    for question in unlanded {
        let on = question.machine.as_deref().map(|m| format!(" on {m}")).unwrap_or_default();
        let text = format!(
            "Dray couldn't pass this answer back to \"{}\"{on}: that session is gone or settled.",
            question.asker
        );
        bot_notice(&question.bot_id, text, sink).await;
    }
    Ok(collected)
}

impl Inbox {
    /// Answers what to send back, and the questions whose answer did not land.
    fn take(&mut self, asks: &[String], ack: &[String], undelivered: &[String], now: u64) -> (Collected, Vec<Question>) {
        let unlanded: Vec<Question> = self.questions.iter().filter(|q| undelivered.contains(&q.id)).cloned().collect();
        self.questions.retain(|q| !ack.contains(&q.id) && !undelivered.contains(&q.id));
        self.questions.retain(|q| now.saturating_sub(q.at) < KEEP_FOR);
        let mut collected = Collected::default();
        for id in asks {
            match self.questions.iter().find(|q| &q.id == id) {
                Some(Question { answer: Some(answer), .. }) => collected.answers.push((id.clone(), answer.clone())),
                Some(_) => {}
                None => collected.gone.push(id.clone()),
            }
        }
        (collected, unlanded)
    }
}

/// A line the reader sees in `bot_id`'s chat, and the agent never does.
#[cfg(any(feature = "serve", feature = "desktop"))]
async fn bot_notice(bot_id: &str, text: String, sink: &crate::sink::Sink) {
    let Ok(bot) = crate::bots::find_bot(bot_id).await else { return };
    let Some(chat) = crate::bots::chat_of(&bot).await else { return };
    notice(&chat, text, sink).await;
}

#[cfg(any(feature = "serve", feature = "desktop"))]
async fn notice(session: &store::SessionIndexItem, text: String, sink: &crate::sink::Sink) {
    let payload = crate::events::AgentEventPayload::Notice { text, model: None };
    if let Err(e) = crate::session::manager().post_event(&session.session_id, session.harness, payload, sink).await {
        eprintln!("[remote asks notice err] {e:#}");
    }
}

/// The asking server's side: collecting answers from the machines asked.
#[cfg(any(feature = "serve", feature = "desktop"))]
mod collect {
    use super::*;
    use crate::{events::MessageSender, machines, sink::Sink};
    use serde_json::json;
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };

    /// How often a machine holding a question is asked. The answer is the
    /// asker's next move, so this is the wait it sees on top of the bot's turn.
    const POLL: Duration = Duration::from_secs(10);
    /// The longest a machine that fails to answer waits between asks.
    const BACKOFF_CAP: Duration = Duration::from_secs(300);
    /// How long a question waits here: past the far side's own keep, its
    /// answer is gone there too.
    const WAIT_FOR: u64 = KEEP_FOR + 24 * 60 * 60;

    /// A question sent from here to a bot on another machine.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Asked {
        /// The question's id, minted here; a v7, so it dates the question.
        pub id: String,
        /// The machine's id in `servers.json`, which a rename leaves alone.
        pub machine: String,
        /// The machine's name when asked, for a notice once it is removed.
        pub machine_name: String,
        /// The bot as it was named, for a notice.
        pub bot: String,
        /// The session that asked.
        pub session_id: String,
        /// The asking bot, whose answer goes to its chat's newest session, as
        /// a local `--ask`'s does: an agent switch may have moved it on.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub bot_id: Option<String>,
        #[serde(default)]
        pub state: State,
    }

    #[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum State {
        /// The bot has yet to answer, or its answer is yet to be collected.
        #[default]
        Waiting,
        /// Sent on to the asker; the far side is yet to hear so.
        Delivered,
        /// Collected, but the asker is gone; the far side is yet to hear so.
        Undelivered,
    }

    static TRACKED: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn tracked_path() -> anyhow::Result<PathBuf> {
        Ok(store::get_home_app_dir().await?.join("remote-asks.json"))
    }

    async fn load() -> Vec<Asked> {
        let Ok(path) = tracked_path().await else { return Vec::new() };
        store::read_json(&path).await.unwrap_or_default()
    }

    async fn save(list: &[Asked]) -> anyhow::Result<()> {
        store::write_atomic(&tracked_path().await?, serde_json::to_string_pretty(list)?).await
    }

    /// Rewrites the list under its lock. Answers what `change` answered.
    async fn edit<T>(change: impl FnOnce(&mut Vec<Asked>) -> T) -> anyhow::Result<T> {
        let _guard = TRACKED.lock().await;
        let mut list = load().await;
        let out = change(&mut list);
        save(&list).await?;
        Ok(out)
    }

    /// A fresh question id, for the forward to carry.
    pub fn mint() -> String {
        uuid::Uuid::now_v7().to_string()
    }

    /// Starts collecting the answer to question `id`, sent to `bot` on `saved`
    /// by `from`, once the far side took it.
    pub async fn track(id: String, saved: &machines::Saved, bot: &str, from: &MessageSender) -> anyhow::Result<()> {
        let asked = Asked {
            id,
            machine: saved.id.clone(),
            machine_name: saved.name.clone(),
            bot: bot.to_string(),
            session_id: from.session_id.clone(),
            bot_id: from.bot_id.clone(),
            state: State::Waiting,
        };
        edit(|list| list.push(asked)).await
    }

    /// Runs for the life of the server. Each tick costs a file read while no
    /// question is out.
    pub async fn run(app: Sink) {
        let mut tick = tokio::time::interval(POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut backoff: HashMap<String, (Instant, Duration)> = HashMap::new();
        loop {
            tick.tick().await;
            collect(&app, &mut backoff).await;
        }
    }

    async fn collect(app: &Sink, backoff: &mut HashMap<String, (Instant, Duration)>) {
        let list = load().await;
        if list.is_empty() {
            return;
        }
        let expired = expire(&list, super::now());
        let machines = machines::load().await;
        let mut by_machine: HashMap<&str, Vec<&Asked>> = HashMap::new();
        for asked in &list {
            by_machine.entry(&asked.machine).or_default().push(asked);
        }
        let mut dropped: Vec<(&Asked, String)> = Vec::new();
        for asked in expired {
            dropped.push((
                asked,
                format!(
                    "No answer came back from {} on {} in a week, so Dray stopped waiting: that machine never answered.",
                    asked.bot, asked.machine_name
                ),
            ));
        }
        let now = Instant::now();
        let mut rounds = Vec::new();
        for (id, mine) in by_machine {
            let mine: Vec<&Asked> = mine.into_iter().filter(|a| !dropped.iter().any(|(d, _)| d.id == a.id)).collect();
            if mine.is_empty() {
                continue;
            }
            let Some(saved) = machines.iter().find(|m| m.id == id) else {
                // Removed, token and all: nothing will ever reach it again.
                for asked in mine {
                    let text = format!(
                        "{}'s answer can't come back: {} was removed from this machine's list.",
                        asked.bot, asked.machine_name
                    );
                    dropped.push((asked, text));
                }
                continue;
            };
            if saved.off || backoff.get(id).is_some_and(|(at, _)| now < *at) {
                continue;
            }
            rounds.push(async move { (saved, collect_from(saved, mine, app).await) });
        }
        if !dropped.is_empty() {
            let gone: Vec<String> = dropped.iter().map(|(a, _)| a.id.clone()).collect();
            if let Err(e) = edit(|list| list.retain(|a| !gone.contains(&a.id))).await {
                eprintln!("[remote asks err] {e:#}");
            }
            for (asked, text) in dropped.into_iter().filter(|(a, _)| a.state == State::Waiting) {
                tell_asker(asked, text, app).await;
            }
        }
        // Side by side, so a machine slow to answer holds up no other's answers.
        for (saved, outcome) in futures_util::future::join_all(rounds).await {
            match outcome {
                Ok(()) => {
                    backoff.remove(&saved.id);
                }
                Err(e) => {
                    let wait = backoff.get(&saved.id).map_or(POLL, |(_, w)| (*w * 2).min(BACKOFF_CAP));
                    backoff.insert(saved.id.clone(), (now + wait, wait));
                    eprintln!("[remote asks err] {}: {e}", saved.name);
                }
            }
        }
    }

    /// Questions waiting longer than the far side keeps them.
    fn expire(list: &[Asked], now: u64) -> Vec<&Asked> {
        list.iter()
            .filter(|a| a.state == State::Waiting)
            .filter(|a| {
                let made = uuid::Uuid::parse_str(&a.id).ok().and_then(|id| id.get_timestamp()).map(|t| t.to_unix().0);
                made.is_some_and(|made| now.saturating_sub(made) >= WAIT_FOR)
            })
            .collect()
    }

    /// One machine's round. Err where it failed to answer, so it backs off.
    async fn collect_from(saved: &machines::Saved, mine: Vec<&Asked>, app: &Sink) -> Result<(), String> {
        let of = |state: State| -> Vec<String> { mine.iter().filter(|a| a.state == state).map(|a| a.id.clone()).collect() };
        let (asks, ack, undelivered) = (of(State::Waiting), of(State::Delivered), of(State::Undelivered));
        let collected = ask(saved, &asks, &ack, &undelivered).await?;
        settle(&ack, &undelivered).await;

        let mut told: Vec<String> = Vec::new();
        let mut unlanded: Vec<String> = Vec::new();
        for (id, answer) in collected.answers {
            let Some(asked) = mine.iter().find(|a| a.id == id && a.state == State::Waiting) else { continue };
            let Some(to) = asker_now(asked).await else {
                if mark(&id, State::Undelivered).await {
                    unlanded.push(id);
                }
                continue;
            };
            // On disk before the send: a crash between the two loses this
            // answer rather than delivering it twice.
            if !mark(&id, State::Delivered).await {
                continue;
            }
            let from = MessageSender {
                session_id: answer.session_id,
                title: answer.title,
                machine: Some(saved.name.clone()),
                bot_id: Some(answer.bot_id),
                reply: Some(true),
                ..Default::default()
            };
            match crate::orchestration::deliver_report(to, answer.text, from, app.clone()).await {
                Ok(()) => told.push(id),
                Err(e) => {
                    eprintln!("[remote asks deliver err] {e:#}");
                    if mark(&id, State::Undelivered).await {
                        unlanded.push(id);
                    }
                }
            }
        }
        let gone: Vec<&Asked> = mine.iter().copied().filter(|a| collected.gone.contains(&a.id)).collect();
        if !gone.is_empty() {
            let ids: Vec<String> = gone.iter().map(|a| a.id.clone()).collect();
            if let Err(e) = edit(|list| list.retain(|a| !ids.contains(&a.id))).await {
                eprintln!("[remote asks err] {e:#}");
            }
            for asked in gone.into_iter().filter(|a| a.state == State::Waiting) {
                let text = format!(
                    "No answer is coming from {} on {}: its server lost the question, most likely to a restart before the bot answered.",
                    asked.bot, asked.machine_name
                );
                tell_asker(asked, text, app).await;
            }
        }
        // Acked at once rather than next poll. Lost, the next poll acks again;
        // a delivered question is never asked for twice.
        if !told.is_empty() || !unlanded.is_empty() {
            match ask(saved, &[], &told, &unlanded).await {
                Ok(_) => settle(&told, &unlanded).await,
                Err(e) => eprintln!("[remote asks ack err] {}: {e}", saved.name),
            }
        }
        Ok(())
    }

    async fn ask(saved: &machines::Saved, asks: &[String], ack: &[String], undelivered: &[String]) -> Result<Collected, String> {
        let args = json!({ "asks": asks, "ack": ack, "undelivered": undelivered });
        let answer = tokio::time::timeout(machines::SWEEP, machines::call(saved, "bot_answers", args))
            .await
            .unwrap_or_else(|_| Err(format!("{} did not answer in time", saved.name)))?;
        serde_json::from_value(answer).map_err(|e| e.to_string())
    }

    /// Moves question `id` to `state` on disk. False where it was not waiting
    /// any more, or the write failed, so nothing is sent on unrecorded.
    async fn mark(id: &str, state: State) -> bool {
        let marked = edit(|list| match list.iter_mut().find(|a| a.id == id && a.state == State::Waiting) {
            Some(asked) => {
                asked.state = state;
                true
            }
            None => false,
        })
        .await;
        marked.unwrap_or_else(|e| {
            eprintln!("[remote asks err] {e:#}");
            false
        })
    }

    /// Stops tracking questions the far side has heard the end of.
    async fn settle(acked: &[String], unlanded: &[String]) {
        if acked.is_empty() && unlanded.is_empty() {
            return;
        }
        let settled = edit(|list| {
            list.retain(|a| match a.state {
                State::Delivered => !acked.contains(&a.id),
                State::Undelivered => !unlanded.contains(&a.id),
                State::Waiting => true,
            })
        });
        if let Err(e) = settled.await {
            eprintln!("[remote asks err] {e:#}");
        }
    }

    /// Where the answer goes now: an asking bot's newest chat session, else
    /// the session that asked while it is here and not settled.
    async fn asker_now(asked: &Asked) -> Option<String> {
        if let Some(bot_id) = &asked.bot_id {
            let bot = crate::bots::find_bot(bot_id).await.ok()?;
            return crate::bots::chat_of(&bot).await.filter(|c| !c.archived).map(|c| c.session_id);
        }
        let item = store::get_session_index_item(&asked.session_id).await.ok().flatten()?;
        (!item.archived).then_some(item.session_id)
    }

    /// A line the reader sees where the answer would have landed.
    async fn tell_asker(asked: &Asked, text: String, app: &Sink) {
        let Some(to) = asker_now(asked).await else { return };
        let Ok(Some(item)) = store::get_session_index_item(&to).await else { return };
        notice(&item, text, app).await;
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn asked(id: &str, state: State) -> Asked {
            Asked {
                id: id.into(),
                machine: "m".into(),
                machine_name: "vps".into(),
                bot: "Ops".into(),
                session_id: "s".into(),
                bot_id: None,
                state,
            }
        }

        /// Only a question still waiting can time out: a delivered one has
        /// landed, and only its ack is outstanding.
        #[test]
        fn only_a_waiting_question_expires() {
            let id = mint();
            let made = uuid::Uuid::parse_str(&id).unwrap().get_timestamp().unwrap().to_unix().0;
            let list = [asked(&id, State::Waiting), asked(&id, State::Delivered)];
            assert!(expire(&list, made + WAIT_FOR - 1).is_empty());
            assert_eq!(expire(&list, made + WAIT_FOR), [&list[0]]);
        }

        #[test]
        fn a_question_reads_back_as_written() {
            let wire = serde_json::to_value(asked("1", State::Delivered)).unwrap();
            assert_eq!(wire["state"], "delivered");
            assert_eq!(serde_json::from_value::<Asked>(wire).unwrap(), asked("1", State::Delivered));
        }
    }
}

#[cfg(any(feature = "serve", feature = "desktop"))]
pub use collect::{mint, run, track};

#[cfg(test)]
mod tests {
    use super::*;

    fn question(id: &str, at: u64, answered: bool) -> Question {
        Question {
            id: id.into(),
            bot_id: "ops".into(),
            asker: "Fix login".into(),
            machine: Some("laptop".into()),
            at,
            answer: answered.then(|| Answer {
                session_id: "chat".into(),
                title: "Ops".into(),
                bot_id: "ops".into(),
                text: format!("answer {id}"),
            }),
        }
    }

    #[test]
    fn an_answer_comes_back_until_acked_and_a_waiting_one_says_nothing() {
        let mut inbox = Inbox { questions: vec![question("1", 0, true), question("2", 0, false)] };
        let (taken, unlanded) = inbox.take(&["1".into(), "2".into()], &[], &[], 10);
        assert_eq!(taken.answers.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["1"]);
        assert!(taken.gone.is_empty() && unlanded.is_empty());
        // Asked again unacked, the same answer comes back.
        assert_eq!(inbox.take(&["1".into()], &[], &[], 10).0.answers.len(), 1);
        // Acked, it goes, and asking for it again says gone.
        let (taken, _) = inbox.take(&["1".into()], &["1".into()], &[], 10);
        assert!(taken.answers.is_empty());
        assert_eq!(taken.gone, ["1"]);
        assert_eq!(inbox.questions, [question("2", 0, false)]);
    }

    #[test]
    fn an_undelivered_answer_goes_and_is_handed_back_for_a_notice() {
        let mut inbox = Inbox { questions: vec![question("1", 0, true), question("2", 0, true)] };
        let (taken, unlanded) = inbox.take(&[], &[], &["1".into()], 10);
        assert!(taken.answers.is_empty());
        assert_eq!(unlanded, [question("1", 0, true)]);
        assert_eq!(inbox.questions, [question("2", 0, true)]);
    }

    #[test]
    fn a_question_past_its_keep_is_gone() {
        let mut inbox = Inbox { questions: vec![question("1", 100, true)] };
        assert_eq!(inbox.take(&["1".into()], &[], &[], 100 + KEEP_FOR - 1).0.answers.len(), 1);
        let (taken, _) = inbox.take(&["1".into()], &[], &[], 100 + KEEP_FOR);
        assert_eq!(taken.gone, ["1"]);
        assert!(inbox.questions.is_empty());
    }

    #[test]
    fn a_collect_reads_back_as_sent() {
        let collected = Collected { answers: vec![("1".into(), question("1", 0, true).answer.unwrap())], gone: vec!["2".into()] };
        let wire = serde_json::to_value(&collected).unwrap();
        assert_eq!(wire["answers"][0][1]["botId"], "ops");
        assert_eq!(serde_json::from_value::<Collected>(wire).unwrap(), collected);
    }
}

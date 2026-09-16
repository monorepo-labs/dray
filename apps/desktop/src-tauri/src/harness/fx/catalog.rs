//! What the Vercel AI Gateway publishes about its own models.
//!
//! [`super::models`] asks `fx models --json` which models the active provider
//! serves, and gets ids alone. The gateway's *catalog* — the list behind that
//! answer — carries each model's effort ladder outright, and fx's own TUI is
//! where that was read: it fetches this list and draws its effort control only
//! where the model names one (`parseReasoningEfforts` in fx's
//! `src/builtins/gateway.zig`). So the ladder is nameable before any session
//! runs, which DRA-221 concluded it was not. That conclusion was right about
//! `fx models` and wrong about the endpoint behind it.
//!
//! **This joins to fx's list rather than replacing it.** fx answers for the
//! reader — authenticated, and its payload carries `private_models_hidden` —
//! where this fetch is anonymous, the gateway key living in fx's own credential
//! store and nowhere Dray can reach. So a model this list does not name is not
//! a model with no ladder: it is one nothing here can answer for, which leaves
//! [`super::models::ladder_for`]'s guess standing and
//! [`super::models::learn_ladder`] to correct it from a live session, exactly
//! as before.
//!
//! **A model it *does* name and gives no ladder is the answer worth having.**
//! `spacexai/grok-4.6` and `anthropic/claude-sonnet-4` take no effort at all —
//! the second is tagged `reasoning` and still offers none, which is why the
//! tag is not read here — and the guess used to offer four rungs on both,
//! leaving fx to refuse one in the transcript.

use crate::models::Effort;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

/// fx's own `models_path` against its own `default_model_catalog_base_url`.
/// Anonymous: fx sends the reader's key where it has one and falls back to
/// this, and the fallback answers the whole public list.
const URL: &str = "https://ai-gateway.vercel.sh/coding-agent/v1/models";

/// How long a miss waits before it is worth asking again.
///
/// A model new enough that the cached catalog has never heard of it *is* an id
/// fx lists and this map does not hold, so a miss carries the "something new
/// shipped" signal on its own and nothing has to diff the two lists. The floor
/// is what keeps that from being a fetch per picker draw forever: a team-private
/// model is a permanent miss, the anonymous catalog never naming one, and so is
/// an entry [`ladder_of`] could not read.
const REFETCH_FLOOR: Duration = Duration::from_secs(600);

/// How long an answer stands before it is asked again whether anything missed
/// or not.
///
/// A miss cannot see a model the gateway *changed* — a rung added to a ladder
/// already held, or effort withdrawn from a model that had it — and Dray is an
/// app people leave open for days, so miss-driven refetching alone would hold
/// one reading for the life of the process. Long, because this is a catalog of
/// published models rather than anything moving: the cost of being a few hours
/// behind is a rung, where the cost of a short ceiling is a fetch nobody asked
/// for on a picker that was already right.
const MAX_AGE: Duration = Duration::from_secs(6 * 60 * 60);

/// Past this the picker is waiting on a list it can do without, and so is a
/// send — [`super::models::find`] reads this path too. Every failure here
/// degrades to the guess, so a slow answer is worth less than a quick admission
/// of none: a few hundred KB wants well under a second, and what this bounds is
/// the unreachable case, which is then held off by [`REFETCH_FLOOR`] rather
/// than paid again on the next read.
///
/// Awaited rather than backgrounded, deliberately. The alternative draws the
/// guess on the first open and corrects it on the second, which is the picker
/// offering rungs the model refuses — the exact thing this module exists to
/// stop — so the wait is bounded instead of dodged.
const TIMEOUT: Duration = Duration::from_secs(2);

/// Every model the catalog names, against the rungs it takes. An empty list is
/// a real answer — *this model has no effort control* — where an absent key is
/// "not in the catalog", and the two must not collapse.
type Ladders = Arc<HashMap<String, Vec<Effort>>>;

struct Cached {
    ladders: Ladders,
    /// When these ladders came back, which is what [`MAX_AGE`] is about — how
    /// old the *answer* is.
    answered_at: Instant,
    /// When the gateway was last asked, answer or not. A failed fetch moves
    /// this and leaves `answered_at` alone, or a machine with no network spends
    /// a whole [`TIMEOUT`] on every read.
    ///
    /// **Two stamps, because one of them lied.** Held as a single field, a
    /// failed refresh at the six-hour mark reset the age as well as the
    /// attempt, so the next try was six hours out rather than [`REFETCH_FLOOR`]
    /// — a transient failure buying a whole extra age's worth of stale ladders.
    tried_at: Instant,
}

/// In memory and never on disk — the bargain [`super::models::LADDERS`] makes
/// next door, for its reason: this is one GET, where a file is a schema to
/// migrate and a corruption path on the launch route.
///
/// A `tokio` mutex rather than a `std` one because it is deliberately held
/// across the fetch: two picker draws landing together should queue on one
/// request rather than make two.
static CATALOG: LazyLock<tokio::sync::Mutex<Option<Cached>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

/// The ladders the catalog holds, fetching it if `wanted` names something it
/// has not heard of and the floor has passed.
///
/// Failure is never reported upward and never fatal: the caller is drawing a
/// picker, and a ladder it cannot improve is one it leaves alone.
pub async fn ladders(wanted: &[&str]) -> Ladders {
    let mut cached = CATALOG.lock().await;

    let ask = match cached.as_ref() {
        None => true,
        Some(held) => should_ask(
            held.answered_at.elapsed(),
            held.tried_at.elapsed(),
            wanted.iter().any(|id| !held.ladders.contains_key(*id)),
        ),
    };

    if ask {
        let tried_at = Instant::now();
        match fetch().await {
            Ok(fresh) => {
                *cached = Some(Cached {
                    ladders: Arc::new(fresh),
                    answered_at: Instant::now(),
                    tried_at,
                })
            }
            Err(err) => {
                eprintln!("[fx catalog] {err:#}");
                // The previous answer stands — a failed refetch must not throw
                // away ladders that were read fine an hour ago — and keeps its
                // own age, so the next try is the floor away and not an age.
                match cached.as_mut() {
                    Some(held) => held.tried_at = tried_at,
                    None => {
                        *cached = Some(Cached {
                            ladders: Ladders::default(),
                            // Nothing was answered, so this is as stale as it
                            // gets: the floor is the only thing holding the
                            // next attempt off.
                            answered_at: tried_at,
                            tried_at,
                        })
                    }
                }
            }
        }
    }

    cached
        .as_ref()
        .map(|held| held.ladders.clone())
        .unwrap_or_default()
}

/// Whether a held answer is worth asking about again — split out from the
/// clock so the rule can be read and tested on its own, which it has earned:
/// the age arm was added in review and took the retry cadence with it.
///
/// **Two reasons to ask, and the floor governs both.** Gating the miss alone
/// left a failed age-driven refresh waiting a whole [`MAX_AGE`] for its next
/// try rather than [`REFETCH_FLOOR`], since the failure moved the stamp the age
/// was read from. It costs a legitimate refresh nothing: an answer old enough
/// to be stale clears a ten-minute floor by definition.
fn should_ask(answered_ago: Duration, tried_ago: Duration, any_missing: bool) -> bool {
    (answered_ago >= MAX_AGE || any_missing) && tried_ago >= REFETCH_FLOOR
}

/// Drops the cached catalog, so the next read fetches. For the reader's manual
/// Refresh alone — the one moment they have said out loud that a list on screen
/// is behind the world.
pub async fn forget() {
    *CATALOG.lock().await = None;
}

async fn fetch() -> Result<HashMap<String, Vec<Effort>>> {
    let listing: Listing = reqwest::Client::new()
        .get(URL)
        .timeout(TIMEOUT)
        .send()
        .await
        .context("asking the AI Gateway for its model catalog")?
        .error_for_status()
        .context("the AI Gateway refused the model catalog")?
        .json()
        .await
        .context("reading the AI Gateway's model catalog")?;

    // An entry `ladder_of` could not read is left *out* of the map rather than
    // filed as empty, which is what makes an unreadable one indistinguishable
    // from a model the catalog never named — the state that already means "keep
    // the guess" everywhere downstream. It costs a permanent miss, bounded by
    // [`REFETCH_FLOOR`] like a private model's.
    Ok(listing
        .data
        .into_iter()
        .filter_map(|entry| Some((entry.id, ladder_of(&entry.reasoning_options)?)))
        .collect())
}

#[derive(Deserialize)]
struct Listing {
    data: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    id: String,
    /// Held as a bare `Value` rather than modelled, because the shape varies
    /// within one response: an option is an object tagged `effort`,
    /// `budget_tokens` or `toggle`, and fx's own parser is written to skip a
    /// member it cannot read rather than fail the entry. A typed field here
    /// would cost the whole *listing* on one unfamiliar option — the rule
    /// `usage.iterations` already pins on the Claude Code side.
    #[serde(default)]
    reasoning_options: Value,
}

/// The rungs one entry offers, out of the first `effort` option it carries —
/// or `None` where the entry is a shape this build cannot read.
///
/// **An empty answer and an unreadable one must not collapse into each other,
/// and they did.** An empty ladder is a *confident negative* that overrides the
/// guess and takes the effort control off the picker, which is the whole point
/// of reading this list. So it may only ever be said about an entry that was
/// understood: `reasoning_options` absent, null, or an array naming no `effort`
/// option is a model with no effort control, where a wire shape that moved
/// under us is `None` and leaves the guess exactly where it was. Reported as
/// absence, that drift would hide a working control and look like the gateway's
/// own answer.
///
/// **First `effort` member, not merged**, which is fx's own reading — a second
/// would be the gateway contradicting itself, and taking the earlier one is at
/// least the same answer fx acts on.
///
/// A level Dray's ladder cannot spell is dropped rather than given a rung:
/// `none` is real here (`openai/gpt-5.4-nano` offers it) and a rung is a
/// persisted enum, so minting one for it would be DRA-140's bug again. Dropping
/// it costs the reader fx's own floor, reachable by leaving effort unset — and
/// an entry whose rungs are *all* unspellable stays a confident empty rather
/// than unknown, since a control offering none of them is the honest draw
/// either way.
fn ladder_of(options: &Value) -> Option<Vec<Effort>> {
    if options.is_null() {
        return Some(Vec::new());
    }

    let Some(offered) = options.as_array() else {
        return None;
    };
    let Some(effort) = offered
        .iter()
        .find(|option| option.get("type").and_then(Value::as_str) == Some("effort"))
    else {
        return Some(Vec::new());
    };

    let values = effort.get("values")?.as_array()?;
    Some(
        values
            .iter()
            .filter_map(Value::as_str)
            .filter_map(Effort::from_arg)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use Effort::*;

    /// Five entries lifted verbatim out of a real catalog read, chosen for the
    /// four answers the picker has to tell apart.
    const CATALOG_JSON: &str = include_str!("fixtures/gateway_catalog.json");

    fn fixture() -> HashMap<String, Vec<Effort>> {
        let listing: Listing = serde_json::from_str(CATALOG_JSON).unwrap();
        listing
            .data
            .into_iter()
            .filter_map(|entry| Some((entry.id, ladder_of(&entry.reasoning_options)?)))
            .collect()
    }

    #[test]
    fn a_model_that_reasons_carries_its_own_ladder() {
        assert_eq!(
            fixture()["anthropic/claude-opus-5"],
            vec![Low, Medium, High, Xhigh, Max]
        );
    }

    /// The whole point of the fetch. Both of these were offered four rungs by
    /// the per-provider guess and refuse every one of them.
    #[test]
    fn a_model_with_no_effort_control_answers_an_empty_ladder() {
        let ladders = fixture();
        assert_eq!(ladders["spacexai/grok-4.6"], Vec::<Effort>::new());
        // Tagged `reasoning` in the same response and still offering no ladder,
        // which is why the tag is not what is read here.
        assert_eq!(ladders["anthropic/claude-sonnet-4"], Vec::<Effort>::new());
    }

    #[test]
    fn a_rung_dray_cannot_spell_is_dropped_not_minted() {
        // The wire says `none, low, medium, high, xhigh`.
        assert_eq!(
            fixture()["openai/gpt-5.4-nano"],
            vec![Low, Medium, High, Xhigh]
        );
    }

    /// A `-fast` twin is kept out of the picker and still has to be runnable,
    /// so its ladder is read like any other row's.
    #[test]
    fn a_hidden_fast_twin_still_gets_a_ladder() {
        assert_eq!(
            fixture()["anthropic/claude-opus-5-fast"],
            vec![Low, Medium, High, Xhigh, Max]
        );
    }

    /// Shapes no capture holds. fx's own parser tolerates each of these, and a
    /// listing must survive one entry being strange — the cost of an unfamiliar
    /// option is that option, never the response.
    #[test]
    fn an_unfamiliar_option_costs_that_option_alone() {
        let strange = serde_json::json!([
            42,
            {"type": "budget_tokens", "min": 1, "max": 2048},
            {"type": "effort", "values": ["low", 7, "invented", "max"]},
            {"type": "effort", "values": ["high"]},
        ]);
        assert_eq!(ladder_of(&strange), Some(vec![Low, Max]));
    }

    /// The three ways an entry says *this model has no effort control*, which
    /// is a real answer and overrides the guess.
    #[test]
    fn a_readable_entry_with_no_effort_option_is_a_confident_empty() {
        assert_eq!(ladder_of(&Value::Null), Some(Vec::new()));
        assert_eq!(
            ladder_of(&serde_json::json!([{"type": "budget_tokens", "min": 1}])),
            Some(Vec::new())
        );
        // Every rung named is one Dray cannot spell, so there is no control to
        // draw whichever way this is read.
        assert_eq!(
            ladder_of(&serde_json::json!([{"type": "effort", "values": ["none"]}])),
            Some(Vec::new())
        );
    }

    /// The other half of that, and the one worth having a test for: a wire
    /// shape this build cannot read must not be reported as *no effort*, or
    /// drift in the gateway's format takes a working control off the picker and
    /// reads as the gateway's own answer.
    #[test]
    fn an_unreadable_shape_is_unknown_and_never_an_empty_ladder() {
        // An object where the wire promises an array.
        assert_eq!(
            ladder_of(&serde_json::json!({"type": "effort", "values": ["high"]})),
            None
        );
        // An effort option carrying no values, or values of a shape that
        // stopped being a list of names.
        assert_eq!(ladder_of(&serde_json::json!([{"type": "effort"}])), None);
        assert_eq!(
            ladder_of(&serde_json::json!([{"type": "effort", "values": {"min": "low"}}])),
            None
        );
    }

    /// The retry cadence, and the case that made it worth a test of its own: a
    /// failed refresh must not push the next attempt out by a whole age.
    #[test]
    fn a_failed_refresh_retries_on_the_floor_not_the_age() {
        let stale = MAX_AGE + Duration::from_secs(1);
        let just_tried = Duration::from_secs(1);
        let past_floor = REFETCH_FLOOR + Duration::from_secs(1);

        // The moment the answer goes stale, with nothing tried recently.
        assert!(should_ask(stale, stale, false));
        // That attempt failed a second ago: hold off, but on the floor —
        // the answer is still stale, and ten minutes later it is asked again.
        assert!(!should_ask(stale, just_tried, false));
        assert!(should_ask(stale, past_floor, false));

        // A miss is the other reason, and takes the same floor.
        assert!(!should_ask(Duration::ZERO, just_tried, true));
        assert!(should_ask(Duration::ZERO, past_floor, true));

        // A fresh answer that names everything asked for is left alone however
        // long ago it was read.
        assert!(!should_ask(Duration::ZERO, past_floor, false));
    }

    /// An unreadable entry is dropped from the map rather than filed empty, so
    /// downstream cannot tell it from a model the catalog never named — which
    /// is what leaves the guess standing.
    #[test]
    fn an_unreadable_entry_is_absent_rather_than_empty() {
        let listing: Listing = serde_json::from_str(
            r#"{"data":[
                {"id":"provider/plain","type":"language"},
                {"id":"provider/drifted","type":"language","reasoning_options":{"effort":["high"]}}
            ]}"#,
        )
        .unwrap();
        let map: HashMap<String, Vec<Effort>> = listing
            .data
            .into_iter()
            .filter_map(|entry| Some((entry.id, ladder_of(&entry.reasoning_options)?)))
            .collect();

        // No `reasoning_options` field at all still parses, and answers.
        assert_eq!(map["provider/plain"], Vec::<Effort>::new());
        assert!(!map.contains_key("provider/drifted"));
    }
}

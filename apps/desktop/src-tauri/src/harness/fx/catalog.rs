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
/// A miss is the only refetch trigger — a model new enough that the cached
/// catalog has never heard of it *is* an id fx lists and this map does not
/// hold, so nothing has to diff the two lists. The floor is what keeps that
/// from being a fetch per picker draw forever: a team-private model is a
/// permanent miss, since the anonymous catalog will never name one.
const REFETCH_FLOOR: Duration = Duration::from_secs(600);

/// Past this the picker is waiting on a list it can do without, and so is a
/// send — [`super::models::find`] reads this path too. Every failure here
/// degrades to the guess, so a slow answer is worth less than a quick admission
/// of none; the fetch is a few hundred KB and wants well under a second.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Every model the catalog names, against the rungs it takes. An empty list is
/// a real answer — *this model has no effort control* — where an absent key is
/// "not in the catalog", and the two must not collapse.
type Ladders = Arc<HashMap<String, Vec<Effort>>>;

struct Cached {
    ladders: Ladders,
    /// When it was last *asked for*, which is not when it was last answered:
    /// a failed fetch stamps this too, or a machine with no network spends a
    /// whole [`TIMEOUT`] on every read.
    at: Instant,
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
        Some(held) => {
            held.at.elapsed() >= REFETCH_FLOOR
                && wanted.iter().any(|id| !held.ladders.contains_key(*id))
        }
    };

    if ask {
        match fetch().await {
            Ok(fresh) => {
                *cached = Some(Cached {
                    ladders: Arc::new(fresh),
                    at: Instant::now(),
                })
            }
            Err(err) => {
                eprintln!("[fx catalog] {err:#}");
                // The previous answer stands — a failed refetch must not throw
                // away ladders that were read fine an hour ago.
                match cached.as_mut() {
                    Some(held) => held.at = Instant::now(),
                    None => {
                        *cached = Some(Cached {
                            ladders: Ladders::default(),
                            at: Instant::now(),
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

    Ok(listing
        .data
        .into_iter()
        .map(|entry| (entry.id, ladder_of(&entry.reasoning_options)))
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

/// The rungs one entry offers, out of the first `effort` option it carries.
///
/// **First, not merged**, which is fx's own reading — a second `effort` member
/// would be the gateway contradicting itself, and taking the earlier one is at
/// least the same answer fx acts on.
///
/// A level Dray's ladder cannot spell is dropped rather than given a rung:
/// `none` is real here (`openai/gpt-5.4-nano` offers it) and a rung is a
/// persisted enum, so minting one for it would be DRA-140's bug again. Dropping
/// it costs the reader fx's own floor, reachable by leaving effort unset.
fn ladder_of(options: &Value) -> Vec<Effort> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .find(|option| option.get("type").and_then(Value::as_str) == Some("effort"))
        .and_then(|option| option.get("values"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter_map(Effort::from_arg)
                .collect()
        })
        .unwrap_or_default()
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
            .map(|entry| (entry.id, ladder_of(&entry.reasoning_options)))
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
        assert_eq!(ladder_of(&strange), vec![Low, Max]);

        // `reasoning_options` absent, null, or an object where the wire
        // promises an array.
        assert!(ladder_of(&Value::Null).is_empty());
        assert!(ladder_of(&serde_json::json!({"type": "effort", "values": ["high"]})).is_empty());
        assert!(ladder_of(&serde_json::json!([{"type": "effort"}])).is_empty());
    }

    #[test]
    fn an_entry_with_no_reasoning_options_field_still_parses() {
        let listing: Listing =
            serde_json::from_str(r#"{"data":[{"id":"provider/plain","type":"language"}]}"#).unwrap();
        assert!(ladder_of(&listing.data[0].reasoning_options).is_empty());
    }
}

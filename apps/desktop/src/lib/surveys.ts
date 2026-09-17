// PostHog in the webview, and it is here for **surveys alone**.
//
// Every event this app reports is still sent by `analytics.rs` over one POST,
// and the SDK is told to capture nothing of its own: no autocapture, no
// pageviews, no session recording. What it does that Rust cannot is draw a
// survey — PostHog's surveys are a `posthog-js` feature, fetched and rendered
// client-side, so without an SDK in the window there is nothing in this app a
// survey could appear in. That, and `$set`ting person properties, which is what
// makes a survey *targetable*: `source: "app"` rides every event as an event
// property today, and survey targeting reads persons.
//
// **The marketing site can never draw one**, whatever a survey is targeted at:
// it loads `posthog-js/dist/module.slim`, which drops surveys outright.
//
// **Consent is read in Rust, once.** `analytics_identity` answers with a key,
// a host, an id and the properties together, or with nothing — and nothing is
// the refusal. Reading `analytics_enabled` here as well would be a second
// reader free to disagree with the first, which is what DRA-199 was.
import posthog from "posthog-js";
import { invoke } from "@tauri-apps/api/core";

import type { SurveyIdentity } from "@/types/events";

/// Whether `init` has run. `posthog.init` a second time is not a no-op, and the
/// settings toggle can reach this after the first call.
let started = false;

/// The id the SDK was started under, so a re-opt-in can tell whether it is
/// still the right one. Opting out clears the stored install id and opting back
/// in mints a fresh one — deliberately a new person — so the bootstrapped value
/// goes stale exactly there and nowhere else.
let identified: string | null = null;

/// Which consent answer is the current one. Taken before the read and checked
/// after it, the same bargain `navGen` makes in `App` and the issue caches make
/// with theirs.
///
/// The startup call is fire-and-forget, so it can still be suspended at its own
/// read when the reader opts out and the settings call makes a second one. The
/// answers can then land in either order — and an *older* one landing last used
/// to be acted on, which starts the SDK under an identity consent has since
/// withdrawn. The refusal has to win however the reads interleave, so a read
/// that is no longer the newest is discarded rather than believed.
let generation = 0;

/// Starts PostHog, or does nothing at all where this install has opted out.
///
/// Safe to call more than once: the second call re-reads consent and is what
/// the settings toggle goes through.
export async function startSurveys(): Promise<void> {
  const mine = ++generation;

  let identity: SurveyIdentity | null = null;
  try {
    identity = await invoke<SurveyIdentity | null>("analytics_identity");
  } catch (e) {
    // Best effort, like every other analytics path: the one thing worse than a
    // survey never appearing is the app failing because one could not.
    console.error("[surveys]", e);
    return;
  }

  // Somebody asked after this read started, so their answer is the current one
  // and this is a reading of consent as it used to be. Dropped rather than
  // acted on, in *both* directions — a stale `null` that opted the SDK out
  // would be as wrong as a stale identity that started it.
  if (mine !== generation) return;

  if (!identity) {
    // Opted out. Nothing to start, and anything already running stops — the
    // switch has to mean something without a restart, the same promise
    // `analytics::enabled` makes by reading the file on every send.
    if (started) posthog.opt_out_capturing();
    return;
  }

  // Narrowed into a const because the `loaded` callback below closes over it,
  // and TypeScript will not carry a `let`'s narrowing into a closure.
  const found = identity;

  if (!started) {
    started = true;
    identified = found.distinctId;
    posthog.init(found.key, {
      api_host: found.host,
      // The id Rust posts under, so the SDK joins that person rather than
      // minting a second one beside it. `bootstrap` and not `identify`: the
      // POSTs have already made this a person, and identifying into it would
      // alias an anonymous id nobody ever used.
      bootstrap: { distinctID: found.distinctId },
      // Surveys target persons, so there has to be one. The app's id is stable
      // and already a person in practice; `identified_only` — the site's
      // setting, where every visit is a new cookieless id — would leave
      // nothing here to target.
      person_profiles: "always",
      // Rust owns events. Everything the SDK would capture on its own is off,
      // including pageviews, which in a single-window desktop app measure the
      // window opening and nothing else.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      loaded: (ph) => ph.setPersonProperties(found.personProperties),
    });
    return;
  }

  // Already running, so this is the reader opting back in. A fresh id means a
  // fresh person and the SDK has to be told; the same id means the toggle went
  // off and on again with nothing minted in between.
  posthog.opt_in_capturing();
  if (identified !== found.distinctId) {
    identified = found.distinctId;
    posthog.identify(found.distinctId);
  }
  posthog.setPersonProperties(found.personProperties);
}

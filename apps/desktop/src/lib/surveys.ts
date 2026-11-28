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
// **Whether to start is Rust's answer.** `analytics_identity` answers with a
// key, a host, an id and the properties together, or with nothing — no key
// compiled in, Settings' switch off, or `DRAY_NO_ANALYTICS` — and nothing is
// the refusal. Settings calls this again after the switch moves.
import type { PostHog } from "posthog-js";
import { invoke } from "@/lib/transport";

import type { SurveyIdentity } from "@/types/events";

/// The SDK once started. `init` a second time is not a no-op, so a later yes
/// opts it back in rather than starting it again.
let posthog: PostHog | null = null;

/// Which call's answer is current. The launch call can still be waiting on its
/// read when the switch makes a second one, and an older answer landing last
/// must not undo the newer one, in either direction.
let generation = 0;

/// Starts PostHog, stops it, or does nothing where Rust refuses. Called at
/// startup and again whenever Settings' analytics switch moves.
export async function startSurveys(): Promise<void> {
  const mine = ++generation;
  try {
    const identity = await invoke<SurveyIdentity | null>("analytics_identity");
    if (mine !== generation) return;
    if (!identity) {
      if (posthog) allow(posthog, false);
      return;
    }
    if (posthog) {
      allow(posthog, true);
      return;
    }
    // Loaded only on a yes: it is ~300KB, parsed otherwise on every launch of a
    // build that sends nothing.
    const sdk = (await import("posthog-js")).default;
    if (mine !== generation || posthog) return;
    posthog = sdk;

    sdk.init(identity.key, {
      api_host: identity.host,
      // The id Rust posts under, so the SDK joins that person rather than
      // minting a second one beside it. `bootstrap` and not `identify`: the
      // POSTs have already made this a person, and identifying into it would
      // alias an anonymous id nobody ever used.
      bootstrap: { distinctID: identity.distinctId },
      // Surveys target persons, so there has to be one. The app's id is stable
      // and already a person in practice; `identified_only` — the site's
      // setting, where a visitor is an anonymous cookie id — would leave
      // nothing here to target.
      person_profiles: "always",
      // Rust owns events. Everything the SDK would capture on its own is off,
      // including pageviews, which in a single-window desktop app measure the
      // window opening and nothing else.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      loaded: (ph) => {
        // The SDK keeps its own opt-out in local storage, so one left by a
        // switch turned off in an earlier run would outlive the switch.
        if (ph.has_opted_out_capturing()) allow(ph, true);
        ph.setPersonProperties(identity.personProperties);
      },
    });
  } catch (e) {
    // Best effort, like every other analytics path: the one thing worse than a
    // survey never appearing is the app failing because one could not.
    console.error("[surveys]", e);
  }
}

/// Moves a started SDK with the switch. Off also stops it drawing a survey
/// already fetched, whose answer could not be sent. On captures no `$opt_in`
/// event: Rust reports everything this app sends.
function allow(ph: Pick<PostHog, "set_config" | "opt_in_capturing" | "opt_out_capturing">, on: boolean) {
  ph.set_config({ disable_surveys: !on });
  if (on) ph.opt_in_capturing({ captureEventName: false });
  else ph.opt_out_capturing();
}

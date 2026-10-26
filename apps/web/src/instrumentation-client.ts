// PostHog for the marketing site, the same project the app reports to.
//
// Next runs this file on the client before hydration (15.3+), which is why
// there is no provider component and nothing in the tree to mount: a `<Script>`
// or a `useEffect` in the layout would both start measuring a page view later
// than the page view happened.
//
// **Three things are off on purpose.** Autocapture, because a click on every
// element is a lot of events for a five-section page and none of them answer a
// question anybody asked. Session recording, for the same reason it is off in
// the app — it is somebody's screen. Person profiles, because nothing here ever
// calls `identify` and an anonymous event is the cheaper meter.
import { posthog } from "@/lib/posthog";

// Absent locally, which is the ordinary case: `pnpm dev` measures nothing, the
// same bargain `POSTHOG_KEY` makes on the desktop side.
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key) {
  posthog.init(key, {
    // Our own domain, rewritten in `next.config.ts`. The point is the share of
    // a developer audience running a blocker, which for this site's visitors is
    // the high end of the range.
    api_host: "/ingest",
    // Where "open in PostHog" links go. Not the ingest host, and unset it
    // points the toolbar at our rewrite, which serves no UI.
    ui_host: "https://us.posthog.com",
    // A cookie, so a visitor keeps one id across pages and visits. Cookieless
    // made every page load a new person: a visit landing on /changelog and
    // downloading from / read as two people, the second "referred" by our own
    // domain, so the source that brought them lost the conversion. No consent
    // banner, by decision — the EU exposure is known and accepted.
    persistence: "localStorage+cookie",
    autocapture: false,
    disable_session_recording: true,
    // The site is one route today, but a pageview that only fires on hard
    // navigation is a bug waiting for the second one.
    capture_pageview: "history_change",
    person_profiles: "identified_only",
    // The desktop app reports into this same project under a stable install
    // uuid where a visitor here is a browser cookie, so an unfiltered
    // "unique users" figure is the sum of two populations that mean different
    // things. Registered from `loaded` rather than after `init` returns,
    // because the initial pageview is captured inside init and a super property
    // only rides captures made after it.
    loaded: (ph) => ph.register({ source: "site" }),
  });
}

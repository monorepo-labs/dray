// The site's one PostHog import, and it exists to be the only one.
//
// **Two entry points would be two module singletons.** `posthog-js` exports a
// default instance per module record, so a file importing `"posthog-js"` beside
// one importing the slim build gets a *second* instance that `init` was never
// called on — and its `capture` calls go nowhere, silently. Everything here
// imports from this file so that cannot happen.
//
// **The slim build, because everything it drops is already off**: autocapture,
// session recording, surveys and the toolbar. 148KB against 309KB unminified,
// which came to 45KB off the site's First Load JS — worth having on a landing
// page, where the bundle is between a visitor and the thing they came for.
//
// The deep path is not a declared export of the package, so a version bump
// could move it. That fails as a build error rather than quietly, which is the
// acceptable direction — but it is why the path is written once, here.
export { default as posthog } from "posthog-js/dist/module.slim";

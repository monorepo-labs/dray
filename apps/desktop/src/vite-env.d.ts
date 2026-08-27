/// <reference types="vite/client" />

/// The branch the dev server was started on, read once at config load in
/// `vite.config.ts` and folded to a constant by `define` — so the dev badge
/// that reads it costs a production bundle nothing. `null` outside a repository
/// and on a detached HEAD.
declare const __DEV_BRANCH__: string | null;

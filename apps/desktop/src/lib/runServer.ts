/// What the composer's Run server button sends, verbatim, as if it had been
/// typed.
///
/// Deliberately vague about *which* server and *how*. The agent reads the repo,
/// so a monorepo with three apps, a Tauri app that opens a window instead of
/// serving a URL, and a stack nobody has heard of all resolve from context —
/// which is why this needs no config file and no stack detection behind it.
///
/// **"in the background" is the one clause that is not vague, and it is
/// load-bearing.** Handed a bare "run server", the CLI runs `pnpm dev` in a
/// *foreground* Bash, which blocks until that tool's own timeout, reports a
/// timeout, and takes the server down with it. Intermittent, and it reads as
/// the button being broken rather than as a prompt being wrong.
///
/// No URL clause either: a Tauri app, a worker or a CLI has none, and where
/// there is one the dev server prints it into the tool output the transcript
/// already renders.
export const RUN_SERVER_PROMPT = "start the dev server in the background";

# Contributing

Dray is a desktop app that runs coding-agent CLIs (Claude Code, Codex, pi, fx,
Grok) in a chat UI. A Rust core spawns each agent, maps its output to one event
model and streams it to a React frontend. The same core runs headless as
`dray-serve`, which the phone apps and remote machines talk to.

[CLAUDE.md](CLAUDE.md) is the full rulebook, for people and agents alike
(`AGENTS.md` links to it). This page is the short version.

## Layout

| Path                  | What                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `apps/desktop`        | The Tauri 2 app: React + Vite frontend, Rust core in `src-tauri`. |
| `apps/cli`            | The `dray` CLI, its own crate and `cli-v*` release.               |
| `apps/ios`            | iPhone and iPad client of a Dray server. SwiftUI, XcodeGen.       |
| `apps/android`        | Android client of a Dray server. Kotlin, Compose, Gradle.         |
| `apps/island`         | Dray Island, the Mac companion panel. SwiftUI.                    |
| `apps/island-linux`   | Dray Island on Linux and Windows. Rust, GPUI.                     |
| `apps/web`            | drayhq.com and Dray accounts. Next.js on Vercel.                  |
| `apps/docs`           | drayhq.com/docs. Blume (Astro) on Vercel.                         |
| `apps/upload-worker`  | `dray upload`'s endpoint. Cloudflare Worker and R2.               |
| `crates/dray-proto`   | The CLI's socket protocol, shared by the CLI and the app.         |

It is one pnpm workspace with one lockfile. The root `package.json` holds no
dependencies, only `pnpm --filter` aliases. Run every other command from the
app's own directory.

## Run the desktop app

You need Node with pnpm, a Rust toolchain and CMake. On Linux, also
WebKitGTK and GTK. At least one agent CLI (say `claude`) must be installed and
signed in, or nothing can send.

```bash
pnpm install                       # at the root, nowhere else
cd apps/desktop && pnpm tauri dev  # or `pnpm app` from the root
```

A dev build skips the sign-in gate and keeps its data in its own home
(`~/.dray-dev`, or `~/.dray-worktrees/<name>` inside a worktree), so it never
touches a release install. `pnpm dev` alone serves the frontend in a browser,
which is good for CSS and nothing that calls the backend.

## Test

```bash
pnpm test:affected            # the suites your branch can reach; run this
pnpm test:affected --dry-run  # print the plan
pnpm test:affected --full     # every suite, before a release
```

It diffs against `origin/main`, uncommitted files included. Per app:

| App                  | Command                                                              |
| -------------------- | -------------------------------------------------------------------- |
| desktop frontend     | `cd apps/desktop && pnpm test` (vitest)                              |
| desktop core         | `cd apps/desktop/src-tauri && cargo test`                            |
| headless server      | `cd apps/desktop/src-tauri && cargo check --no-default-features --features serve --bin dray-serve --tests` |
| CLI                  | `cd apps/cli && cargo test`                                          |
| web, upload-worker   | `pnpm test` in the app's directory                                   |
| Android              | `cd apps/android && ./gradlew testDebugUnitTest`                     |
| iOS                  | `cd apps/ios && xcodegen`, then ⌘U in Xcode                         |

`pnpm test:affected` does not reach the Android and iOS apps. A filtered
`cargo test` rewrites `src/types/events.ts`, so follow it with a bare one.

A UI change wants more than tests: run the app, use the change, and take a
screenshot or recording for the PR.

## Pull requests

1. **Open an issue first** for a feature, bug fix or refactor, and put
   `Fixes #123` in the PR body. Docs, tooling and copy tweaks need none.
2. **Open the PR as a draft** while you work: `gh pr create --draft`. Drafts
   are not reviewed.
3. **Mark it ready** (`gh pr ready`) when it is done. That runs the
   `Claude Code Review` Action
   ([workflow](.github/workflows/claude-code-review.yml),
   [prompt](.claude/commands/ci-code-review.md)) on every push from then on.
   Its `claude-review` check is required on `main`.
4. **Fix what it finds** and push. It reviews each push again. A PR is ready
   to merge when the latest review on the head commit says "No issues found",
   "No new issues found since …", or "Skipped: …" for a trivial change. A run
   that posts no comment is a broken review, not a clean one.
5. **Squash merge.** One commit per PR on `main`, titled with its number.

A PR that touches only markdown, images or video is not reviewed: the check
passes on its own.

### Screenshots and videos

A change you can see wants a screenshot in its PR, and motion wants a video.
Upload each with the `dray` CLI and paste the line it prints into the PR body:

```bash
dray upload before.png after.png
```

- Signs in with `GITHUB_TOKEN` if set, else `gh auth token`. The token is
  checked with GitHub and never kept.
- PNG, JPEG, GIF or WebP up to 20 MB. MP4, WebM or MOV up to 100 MB. 30
  uploads an hour per account.
- A video prints as a plain link: GitHub embeds only videos uploaded through
  its own editor.
- Uploads are public. Upload only what belongs in a public PR.
- Never commit images to the repo or push a branch to hold them.

No `dray` CLI? Install it with
`curl -fsSL https://www.drayhq.com/install.sh | sh`, or call the endpoint
directly. It answers JSON with the public `url`:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$(gh auth token)" \
  | curl -s -K - --data-binary @shot.png https://upload.drayhq.com/
```

The endpoint is [apps/upload-worker](apps/upload-worker); its
[README](apps/upload-worker/README.md) says how to run it locally.

## Code style

The full rules are in [CLAUDE.md](CLAUDE.md). In brief:

- **Comment sparingly**, about one line in ten. Say why, not what.
- **Doc comment on every `pub fn`**: one line, the same why-not-what bar.
- **Write plainly** in code, comments, docs and commits. Short sentences,
  active voice, no filler.
- **Use pnpm**, never npm.
- **Frontend imports `invoke` and `listen` from `@/lib/transport`**, never from
  `@tauri-apps/api` directly.
- **Read the subsystem doc first.** Before touching an area, read its file in
  [apps/desktop/docs](apps/desktop/docs), and [DESIGN.md](apps/desktop/DESIGN.md)
  before restyling anything.
- **Never edit generated files.** `src/types/events.ts` comes from `cargo test`.

## Questions

Open a [GitHub issue](https://github.com/monorepo-labs/dray/issues). It is the
only tracker; the repo has no Discussions.

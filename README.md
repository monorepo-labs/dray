# Dray

A desktop home for your coding agents. Tauri 2 app that wraps coding-agent CLIs
in a native chat UI.

## Layout

pnpm workspace.

| Path           | What                                                        |
| -------------- | ----------------------------------------------------------- |
| `apps/desktop` | The Tauri app. React 19 + Vite frontend, Rust backend.       |
| `apps/web`     | Marketing site. Next.js App Router, deployed to Vercel.      |
| `packages`     | Shared code. Empty until something is genuinely wanted twice. |

## Getting started

Install once, from the root — the lockfile covers the whole workspace.

```bash
pnpm install
```

Then run either app from the root:

```bash
pnpm app    # desktop app (Tauri + Vite)
pnpm web    # marketing site on :3000
```

Anything beyond starting them wants the package's own directory, because
`tauri.conf.json`, `.cargo/config.toml` and `scripts/install.sh` all resolve
their paths against it:

```bash
cd apps/desktop && pnpm tauri build
cd apps/desktop/src-tauri && cargo test
```

## Deploying the site

Vercel, with **Root Directory** set to `apps/web`. Vercel reads the workspace
lockfile at the repo root on its own; no `vercel.json` is needed.

GitHub Pages on this repo is already taken — it serves the desktop app's
updater manifests off the `updates` branch. Don't point the site at it.

## Releasing the app

Tag `vX.Y.Z` for stable, `vX.Y.Z-beta.N` for beta. The version in the tag has
to match `apps/desktop/src-tauri/tauri.conf.json`, and a stable release needs a
matching `## X.Y.Z` section in `apps/desktop/CHANGELOG.md` — the workflow fails
loudly on either.

## Themes

Four of the palettes Dray ships are ports of other people's work, used under
the MIT licence and unchanged in intent — the colours are theirs, the token
names are ours. Dray, the default, is our own.

| Theme                                                   | By                       |
| ------------------------------------------------------- | ------------------------ |
| [Catppuccin](https://github.com/catppuccin/catppuccin)   | the Catppuccin org       |
| [Cobalt2](https://github.com/wesbos/cobalt2-vscode)      | Wes Bos, Roberto Achar   |
| [One Dark Pro](https://github.com/Binaryify/OneDark-Pro) | Binaryify                |
| [gruvbox](https://github.com/morhetz/gruvbox)            | Pavel Pertsev (@morhetz) |

Full licence texts are in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) —
MIT asks the notice travel with the work, so a credit line on its own is not
enough.

**Which repo a port comes from is part of the port.** Cobalt2 is taken from the
**VS Code** theme, not `wesbos/cobalt2`, which is the original Sublime one and
carries no licence file at all — the colours are the same in both and only one
of them grants permission to ship them. gruvbox is the reverse trap: it has no
licence file either, so GitHub reports it as unlicensed, but it declares MIT in
its `package.json`. One Dark Pro takes its surfaces from that repo's own
`darker` variant and its text from the main one.

Cobalt2 and One Dark Pro are dark-only, because neither has a light palette
upstream and a light one is a second full ramp rather than an inversion.
Picking either disables the mode control and says why.

Ports live in `apps/desktop/src/App.css`, each value commented with the name it
carries upstream (`surface0`, `bg0_h`) so a port can be checked against its
source rather than taken on trust.

## Marks

The agent picker draws each harness's own mark, redrawn on `currentColor` so it
sits in a row of muted chrome rather than shouting over it
(`apps/desktop/src/components/AgentIcon.tsx`).

| Mark | Licence |
| ---- | ------- |
| [pi](https://pi.dev) | MIT, © Earendil Inc. & Contributors |

Claude's and OpenAI's are trademarks of their owners, used to name the agent a
session runs on and nothing else. pi's is under a licence that asks for
attribution, which is why it is the only row here.

## Transcription

Dictation in the composer is local, and it runs on
[transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) — MIT, the
`transcribe-cpp` crate, which executes the GGUF model and is Metal-accelerated
on Apple Silicon.

That engine is its own repository under the `handy-computer` org, published and
licensed separately from the app below, and Dray depends on it the ordinary way
through Cargo. Updates arrive as crate versions; **nothing here tracks the Handy
app, because none of it is vendored.**

The debt is to [Handy](https://github.com/cjpais/Handy) by
[CJ Pais](https://cjpais.com) — MIT — the privacy-focused speech-to-text app
that got there first and got it right, and the reason that engine exists at all.
Two files are taken from it directly: the dictation sounds, below.

The models are the `handy-computer` org's own GGUF conversions, fetched from
Hugging Face and pinned to a revision
(`apps/desktop/src-tauri/src/transcription/catalog.rs`). Weights are CC-BY-4.0
and carry their base models' own terms.

The two dictation sounds are Handy's own marimba pair, copied verbatim from its
repository under its MIT licence
(`apps/desktop/src/assets/dictate-{start,stop}.wav`). They are the only Handy
files in this tree.

**What Dray did not take is the app.** Handy solves global hotkeys, injecting
text into whatever window has focus, a tray and a history — none of which Dray
needs, because it owns the composer the words land in. The debt is to the engine
and to the judgement about which models are worth offering, and Handy's own
ranking is where this one's list started.

Handy's name, logo and brand assets are **not** covered by its MIT licence and
are not used here.

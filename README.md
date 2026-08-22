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

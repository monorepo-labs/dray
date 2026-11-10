# Dray on GPUI

The desktop app rewritten on Zed's GPUI (#856). It ships beside the Tauri app
until it reaches parity, Mac first.

**Milestone 1 is a client only.** It attaches to the server this Mac already
runs and owns none: it reads `serve-port` and `serve-token` from the home dir
(`DRAY_HOME`, else `~/.dray`) and speaks the wire in
[SERVE-PLAN.md](../desktop/SERVE-PLAN.md).

## Running it

```bash
cd apps/gpui
cargo run
```

That attaches to the release app's server. Against a server of your own:

```bash
cd apps/desktop/src-tauri
cargo build --no-default-features --features serve --bin dray-serve
DRAY_HOME=/tmp/dray-test DRAY_ENDPOINT=/tmp/dray-test/dray.sock ./target/debug/dray-serve --port 7341

cd apps/gpui
DRAY_HOME=/tmp/dray-test cargo run
```

`DRAY_ENDPOINT` keeps the test server's agents and `dray` CLI off the real app's
socket. `cargo test` runs the ported sidebar ordering and the colour maths.

## What it is built on

- **`gpui-pre` 0.3.12, pinned exactly**, a weekly crates.io snapshot of Zed
  main. The official `gpui` crate is a year behind. `gpui-component` pins the
  same snapshot, so its machinery stays reachable for anything whose look we
  can make identical.
- **`font-kit` and `runtime_shaders` on the platform crate.** Without
  `font-kit` GPUI uses a no-op text system and draws no text at all, silently.
  `runtime_shaders` means the build needs the Command Line Tools, not Xcode.
- **The core crate by path, default features off**, so `SessionIndexItem`,
  `AgentEvent` and the wire's own `admit_with` are shared, not rewritten. No
  root workspace, on purpose. The core builds as an `rlib` alone, since a
  `cdylib` beside it drops the hash from its file names and two lockfiles
  sharing one build dir then overwrite each other's copy.
- **Glass is the `sidebar` material**, put under the content view by
  [glass.rs](src/glass.rs). GPUI's own `Blurred` strips the material's tint,
  and App.css's alphas were tuned over the tinted one.
- **Tokens are copied from App.css in its notation** ([theme.rs](src/theme.rs),
  [color.rs](src/color.rs)): `oklch()` and `color-mix(in oklab, …)`, so a value
  can be checked against the stylesheet line for line. DESIGN.md is the rulebook.
- **Logic is ported, not reinvented.** [sessions.rs](src/sessions.rs) is
  Sidebar.tsx's `sessionRows`/`sessionGroups` with the tests that pin them.

Geist is the Vercel font (SIL OFL, [assets/fonts/LICENSE.txt](assets/fonts/LICENSE.txt));
icons are lucide (ISC) and heroicons (MIT), licences beside them in
[assets/icons](assets/icons).

## Milestone 1, so far

- [x] Crate, pinned GPUI, glass window, titlebar drag row
- [x] Wire client: hello, `invoke`, events, reconnect
- [x] Sidebar session list, live: stages, pins, nesting rails, unread and asking rails
- [ ] Virtualised transcript with streaming markdown
- [ ] Tool rows, tree-sitter code and diffs
- [ ] Permission and question cards
- [ ] Composer that sends
- [ ] New-task composer with its pickers

Not yet in the sidebar: PR marks and the PR stages, split groups, search, the
settled and drafts lists, the row menu, and the working orb.

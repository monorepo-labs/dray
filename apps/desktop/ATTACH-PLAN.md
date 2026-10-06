# Attaching a project from GitHub

monorepo-labs/dray#422, stage 5 of "Dray anywhere". On a remote server the
Mac's folder dialog cannot see the machine, so attaching needs a way in that
runs there. The design is settled in the issue; this is how it is built.

## Rust: two new commands, one changed

All in [projects.rs](src-tauri/src/projects.rs), all in `serve.rs`'s table, so
the same Rust answers on the Mac and on a server. The frontend names the
server with `invoke(cmd, args, server)`; nothing new in the transport beyond
adding both to `QUALIFIED`, so the paths they answer come back as `dray://`.

- **`github_repos() -> Vec<GithubRepo>`, failing as `PrUnavailable`.** One
  `gh api user/repos --paginate`, affiliation owner, collaborator and
  organisation member, newest push first. Each repo carries `path`: where it
  already lives on that machine, read off the `origin`-style GitHub remote of
  every attached project and every directory in `~/dray`. Those sort first.
  Failure reuses the PR panel's reading, so `no_cli` and
  `not_authenticated` arrive typed.
- **`clone_github_repo(slug) -> Vec<Project>`.** `~/dray/<repo>` already a
  clone of `slug` → attach it. Already there holding anything else → refuse,
  naming what is there. Otherwise `gh repo clone <slug> ~/dray/<repo> --
  --progress`, each stderr line emitted as `clone_progress {slug, line}`, the
  failure in gh's own last lines. Then `add_project`.
- **`add_project` expands a leading `~/`** — a reader typing a path on a
  server does not know its home — and refuses a file as well as a missing
  path.

`~/dray` is the real home, never `DRAY_HOME`: that moves Dray's data, and a
clone is the reader's work.

## Frontend: one dialog

`AttachProjectDialog`, opened by the picker's "Attach project…" in place of the
folder dialog.

- **Server**: a `Segmented` switch at the top, drawn only while a remote server
  is connected. Starts on the selected project's server.
- **List**: a search box over `github_repos`, filtered as typed. A row is the
  slug and description; one already on that machine says **Attached** or
  **Cloned**. A click selects; **Attach** acts — attaching what is already
  there, cloning the rest, with a spinner and gh's latest progress line on the
  row.
- **States**: reading; `no_cli` / `not_authenticated`, drawn by the PR panel's
  `MissingCli` (on a server the command is `dray setup` or `gh auth login`, to
  run there, and no Mac terminal is offered); any other failure in gh's words;
  an empty list.
- **Footer**: **Choose folder…** first, on the Mac alone; **Enter path…**,
  which opens a path field for that server; **Attach** at the far end.
- **No `gh` on a server is not worked around** by cloning on the Mac and
  copying across: the server needs `gh` anyway for every PR it opens, so the
  dialog sends the reader to set it up there.
- Every route ends in the project list `add_project` answers, merged for that
  server and the newest-stamped project selected.

## Not here

A clone folder per pick, other hosts, cancelling a clone mid-way.

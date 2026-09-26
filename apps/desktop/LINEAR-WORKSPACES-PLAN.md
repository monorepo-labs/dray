# Several Linear workspaces, pinned per project

Today Dray holds one Linear key, so it reads one workspace. This plan lets a
reader connect several and pin a Dray project, or a whole Dray Space, to one
of them. Several projects can share a workspace: `jangoai-ios`,
`jangoai-android` and `jangoai-monorepo` all pinned to the JangoAI workspace,
or filed in one Space pinned to it once. It keeps the seam `issues/issues.rs` already has: nothing here is a
new tracker, and GitHub is untouched.

"Workspace" here always means a **Linear** workspace (an organization, e.g.
`linear.app/acme`), never a Dray Space. "Project" means a Dray project, a
directory attached in the sidebar. "Space" means a Dray Space (Settings →
Spaces), a group of projects.

**Built**, docs included (all five steps below). Decisions 4 and
8 were settled with the reader, the rest were proposed and then built as
written. The
whole plan wants the maintainer's yes on a GitHub issue before code lands,
since "the connection is workspace-wide — no project ↔ team mapping" was a
deliberate rule (CLAUDE.md, _Issues_). This plan maps projects to
*workspaces*, not teams.

## What the research found

| Fact | Status | Source |
|---|---|---|
| A personal API key belongs to one user in one workspace. Several workspaces means several keys. | Confirmed | [workspaces](https://linear.app/docs/workspaces), schema `User.organization` |
| `viewer { organization { id name urlKey logoUrl } }` names the key's workspace. | Confirmed | [schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) |
| `urlKey` can be renamed by an admin (last 3 kept as redirects). `organization.id` cannot. | Confirmed | schema `previousUrlKeys` |
| Team keys are unique only inside a workspace, so `ENG-12` can exist in two. | Inferred | schema: `Team.key`, `Issue.number` scoped to team |
| Issue URLs are `linear.app/<urlKey>/issue/<IDENT>/<slug>`. | Confirmed | a live issue URL |
| Upload URLs are `uploads.linear.app/<uuid>/<uuid>/<uuid>`, and the first segment looks like the org id. Undocumented. | Inferred | public issue attachments |
| Uploads take the same `Authorization` header as the API. One report says a personal key gets 401 there. | Confirmed / unverified | [file storage](https://linear.app/developers/file-storage-authentication), [linear-cli#211](https://github.com/schpet/linear-cli/issues/211) |
| Rate limit is per user: 2,500 requests/hour on a key. One user per workspace, so each workspace has its own budget. | Confirmed / inferred | [rate limiting](https://linear.app/developers/rate-limiting) |
| Nearest prior art: `schpet/linear-cli`. Workspaces are detected from the key, the first one is the default, and a project's `.linear.toml` pins a workspace. | Confirmed | [authentication.md](https://github.com/schpet/linear-cli/blob/main/docs/authentication.md) |

## Decisions

1. **One key per workspace, identified by `organization.id`.** `VIEWER` in
   [linear.rs](src-tauri/src/issues/linear.rs) gains `organization{id name
   urlKey}`. `id` is the identity everywhere; `urlKey` is only for matching a
   URL, since an admin can rename it.
2. **`credentials.json` is the record of what is connected, not
   `settings.json`.** `AppSettings` has no `unknown` flatten, so an older
   build sharing `~/.dray` drops any field it cannot spell the first time it
   saves a setting. `credentials.json` is a plain map and round-trips whole.
   Entries:
   - `linear`: the **default** workspace's key, unchanged, so an older build
     keeps working with it.
   - `linear/<orgId>`: each further workspace.

   The invariant is that if any workspace is connected, `linear` holds one.
   Removing the default promotes the next one into that slot. A read that
   finds extras with no `linear` entry (an older build disconnected) repairs it
   the same way. Adding a key whose org is already connected **replaces** that
   entry (reauthorize), never a second row.
3. **`settings.json` holds a display cache only.** `linear_workspaces:
   Vec<TrackerAccount>` carries name, user, `workspace_id`, `url_key`. An entry
   with no cache row is verified once and cached. That is the recovery path when
   an older build wiped the field. `linear_account` stays and mirrors the
   default, so an older build still draws the right name.
4. **A project or a Space pins a workspace; the most specific pin wins.**
   *(Settled with the reader.)* A project's workspace is, in order:
   1. The project's own pin.
   2. Its Space's pin, if it is filed in a Space.
   3. The default.

   A pin naming a workspace that is no longer connected is skipped, not
   honoured.
   - **Project pin:** `Project.linear_workspace: Option<String>` (an org id)
     in `projects.json`, `#[serde(default)]`, beside `space`. It is the same
     kind of record a Space is: a tag on the project and nothing else.
   - **Space pin:** `linear_space_pins: BTreeMap<String, String>` (Space name →
     org id) in `settings.json`. A Space has no record of its own in Rust (its
     existence is the tags plus the frontend's declared list), and this has to
     be Rust-readable. It applies to every project filed in the Space,
     including ones filed later.
   - **Rename and remove follow the Space.** `retag_space` already rewrites
     the tags in one call. It now also moves or drops the pin. That is two
     files, written projects first. If the settings write fails, the pin is
     lost under the old name and those projects fall back to the default:
     visible, and fixed by re-pinning.
   - **Many to one:** any number of projects or Spaces may name one workspace.
   - **Rust reads it:** a session's `project_path` leads to its project, and so
     to its Space and its workspace. Tag expansion in `send_msg` and
     `dray new --issue` need no frontend. Worktree sessions resolve through
     `project_path` like everything else.
   - **Default:** the workspace in the `linear` slot (the first connected).
     Settings can make another one the default, which swaps the two entries in
     `credentials.json` so an older build follows it.
   - **Removing a workspace clears every pin naming it**, project and Space
     alike, the way removing a Space clears its tags (`retag_space`).
   - **Cost:** neither `Project` nor `AppSettings` has an `unknown` flatten, so
     an older build rewriting either file drops the pins it holds. Those
     projects fall back one level until re-pinned. Spaces already accept that
     trade.
5. **Never a merged list.** Same rule as the tracker chips
   ([COPY-ISSUES.md](COPY-ISSUES.md), _Tracker chips_): one workspace's
   priorities do not order another's issues.
6. **The Issues page opens on the current project's workspace.**
   - "Current" is the project the composer has selected.
   - A `WorkspaceMenu` (drawn at two or more workspaces) switches the view for
     that visit and changes no pin.
   - Selecting another project puts the page back on that project's workspace.
7. **The `#` picker reads the session's project workspace and has no
   switcher.** A tag inserted from it is therefore always from the workspace
   its session will resolve against, which removes the ambiguity in decision 8
   for every picked tag.
8. **Tags stay `#ENG-12` and resolve in the session's project workspace
   first.** *(Settled with the reader.)* Then the default, then the others;
   the first match wins and records its workspace on the ref. Cost: a *typed*
   tag for another workspace's issue whose identifier also exists in the
   pinned one links the pinned one.
9. **Every Linear command takes `workspace: Option<String>`.** The frontend
   passes it wherever it knows it. A linked issue picks its key in this order:
   1. The ref's own `workspace`.
   2. The workspace whose `url_key` matches the ref's URL.
   3. The session's project workspace.
   4. The default.
   5. The others, stopping at the first that finds it.
10. **`IssueRef` and `Issue` gain `workspace: Option<String>`**
    (`#[serde(default, skip_serializing_if = "Option::is_none")]`). It is a
    hint, not load-bearing. `IssueRef` has no flatten, so an older build
    rewriting the index drops it, and decision 9 still finds the issue. Link
    and unlink in [store.rs](src-tauri/src/store.rs) also match on workspace
    when both sides carry one, or `ENG-12` from two workspaces replace each
    other.
11. **An upload uses the key of the issue it belongs to.** The panel drawing it
    knows the issue's workspace and passes it to `fetch_issue_asset`. The first
    path segment as org id is the fallback only, since it is undocumented.
    **Test upload auth with a personal key before building this** (see _Build
    order_, step 0).
12. **No protocol bump.** `dray issue link --url` already carries the `urlKey`;
    `dray new --issue` resolves through the new session's project. A
    `--workspace` flag later would be v7.
13. **Frontend caches key on workspace.** List key and detail key
    (`<org>:<identifier>`) both carry it. Switching workspace needs no
    `forgetIssues()`. Adding or removing one still calls it, as today.

## Backend

- [issues.rs](src-tauri/src/issues/issues.rs)
  - `read_key()` → `read_keys()`, answering every `(entry, key)`.
    `linear_key(workspace)` picks one; the promotion repair lives here.
  - `write_key`/`delete_key` → `store_workspace_key(org, key)`,
    `remove_workspace(org)` and `make_default(org)`, all under
    `CREDENTIALS_LOCK`.
  - `workspace_for_project(path)`: project pin, then Space pin, then default
    (decision 4). One function, called from tag expansion and from the key
    choice in decision 9. It also answers *which level* the answer came from,
    for the Settings label.
  - `TrackerAccount` gains `workspace_id`, `url_key` (`#[serde(default)]`).
    GitHub leaves both `None`.
  - `IntegrationsView.linear` becomes `Vec<TrackerAccount>`, default first.
    The type change is deliberate: the regenerated TS breaks every frontend
    site that assumed one account.
  - Commands:
    - `connect_linear(key)` now adds.
    - `disconnect_linear(workspace)`.
    - New `set_linear_default(workspace)`.
    - `workspace` added to `get_issue`, `update_issue`, `fetch_issue_asset` and
      `list_issue_filters`.
    - `IssueQuery` gains `workspace`, which covers `list_issues`.
  - `expand_tags`: read every key once, resolve in the order of decision 8,
    stamp `workspace` on the ref.
  - `IssueUnavailable` copy: "Linear rejected the key for this workspace."
- [projects.rs](src-tauri/src/projects.rs):
  - `linear_workspace` on `Project`.
  - New command `set_project_linear_workspace(path, workspace: Option<String>)`,
    one write under `PROJECTS_LOCK`.
  - `clear_linear_workspace(org)`, called by `remove_workspace`.
  - `retag_space` moves or drops the Space's pin after rewriting the tags.
- [linear.rs](src-tauri/src/issues/linear.rs): `VIEWER` fields; `verify`
  returns them; `map_issue` stamps `workspace`.
- [settings.rs](src-tauri/src/settings.rs): `linear_workspaces` and
  `linear_space_pins`, both `#[serde(default)]`. New command
  `set_space_linear_workspace(space, workspace: Option<String>)`, through
  `settings::update`. Consider adding an `unknown` flatten to `AppSettings`
  and `Project` in the same PR. It cannot protect against builds already
  shipped, but it protects the next field someone adds.
- [store.rs](src-tauri/src/store.rs): link/unlink match on workspace.
- [analytics.rs](src-tauri/src/analytics.rs): `linear_connected` for the
  first workspace, `linear_workspace_added` for each after.
- `cargo test` regenerates `src/types/events.ts`.

## Frontend

- [useIntegrations.ts](src/hooks/useIntegrations.ts): `connect(key)` adds;
  `disconnect(workspace)`; `makeDefault(workspace)`; exposes `workspaces`.
- [issueTracker.ts](src/lib/issueTracker.ts): `connected.linear` becomes
  `integrations.linear.length > 0`.
- [useIssues.ts](src/hooks/useIssues.ts): workspace in the list key and the
  detail key; reset query and filters on a workspace change, as a tracker
  change does now; pass `workspace` to every `invoke`.
- [useIssueSearch.ts](src/hooks/useIssueSearch.ts): `queryFor` carries the
  session's project workspace. When the Issues page is on the same workspace,
  the picker still shares its cache entry.
- [IssuesView.tsx](src/components/IssuesView.tsx): starts on the current
  project's workspace (decision 6). A `WorkspaceMenu` beside the filters,
  shaped like GitHub's `RepoMenu`, is drawn at two or more workspaces. Its last
  item, **Add workspace…**, opens Settings → Integrations, where the field is.
- [IssuePanel.tsx](src/components/IssuePanel.tsx) and
  [IssueAsset.tsx](src/components/IssueAsset.tsx): pass the issue's workspace
  to `fetch_issue_asset`.
- [SettingsPage.tsx](src/components/SettingsPage.tsx), Integrations tab:
  - **Workspaces:** one row per workspace (`{Acme}, as {Yogesh}`), the default
    marked. Each row has Disconnect (in-row confirm, one `confirming` id in the
    parent) and **Make default** on the others. **Add workspace** opens a key
    field in place: the Issues page's connect pane is for the reader with none
    connected, and "another" belongs beside the list it adds to.
  - **Spaces:** drawn at two or more workspaces and one or more Spaces. One
    row per Space, each with a menu: *Default (Acme)*, then every workspace by
    name. Filing the three JangoAI repos in a "JangoAI" Space and pinning it
    here is the one-step setup.
  - **Projects:** drawn at two or more workspaces. One row per attached
    project. Its menu's first item says what the project inherits and from
    where, e.g. *From Space JangoAI (JangoAI)* or *Default (Acme)*, then every
    workspace by name. A project pin is for the exception, such as one repo in
    the Space that tracks work in another workspace.
  - Both lists sit in Integrations rather than in the Spaces tab, so every
    Linear setting is in one place and the Spaces tab keeps doing one job.
- [UserMessage.tsx](src/components/chat/UserMessage.tsx): match a tag to its
  link on workspace too, when present.
- [COPY-ISSUES.md](COPY-ISSUES.md): workspace rows, the Projects list, the
  menu, "Add workspace", "Make default", and "the saved key" → "the key for this
  workspace".

## Tests

- Rust:
  - Promotion when the default is removed; repair when `linear` is missing
    but extras exist.
  - Reconnecting an org replaces its key; making another default swaps the two
    entries.
  - `workspace_for_project`: project pin beats Space pin beats default; a
    project in no Space; a pin naming a removed workspace is skipped; a
    worktree session reaching its project through `project_path`.
  - Renaming a Space moves its pin; removing a Space drops it.
  - Removing a workspace clears every project and Space pin naming it.
  - Key choice order for a linked issue (decision 9); `urlKey` match on an
    issue URL.
  - Link/unlink with the same identifier in two workspaces.
  - `Project`, `TrackerAccount` and `IssueRef` still parse without the new
    fields (older files).
- TS:
  - List and detail cache keys differ by workspace.
  - The Issues page follows a project change.

## Build order

0. **Check upload auth (5 min, needs a real key).** Run this with a key and any
   upload URL from one of your issues. A 200 means decision 11 stands; a 401
   means switching to the `public-file-urls-expire-in` header instead.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: $LINEAR_API_KEY" "<uploads.linear.app URL>"
   ```
1. Storage and identity: `VIEWER`, credentials entries, settings cache,
   `get_integrations`, connect, disconnect, make default. Rust tests.
2. Pins: `Project.linear_workspace`, `linear_space_pins`, both set commands,
   `workspace_for_project`, `retag_space` carrying the pin, clearing on
   removal.
3. Workspace on every read and write: commands, `IssueRef`/`Issue`, tag
   expansion, link matching.
4. Frontend: types, `useIntegrations`, caches, `WorkspaceMenu`, Settings
   workspaces, Spaces and projects lists, copy.
5. Update CLAUDE.md: in _Issues_, "workspace-wide", "no project ↔ team
   mapping" and "the key is the connection" all change meaning. In _Spaces_,
   "a space is a way of looking at them" no longer covers everything, since a
   Space can now decide which Linear workspace its projects read.

Roughly 30 files. About 4–6 days by hand; one PR, one commit per step.

## Open questions

1. **Upstream first?** Recommended: open an issue with this plan and wait for
   a yes. Three rules this bends were written on purpose: the connection is
   workspace-wide, there is no project mapping, and a Space only changes what
   is drawn.
2. **Should the Issues page's `WorkspaceMenu` also offer "Pin to
   <project>"?** It saves a trip to Settings the first time. Recommended: yes,
   as the menu's second-last item, drawn only when the current project's pin
   differs from the workspace on screen.

## Out of scope, on purpose

- A default *team* per project (e.g. `jangoai-ios` → the iOS team). CLAUDE.md
  rejects project ↔ team mapping; a workspace pin is the coarser half of that
  and a separate question.
- OAuth sign-in. Keys stay the only way in; OAuth is its own project.
- A merged list across workspaces (decision 5).
- `dray --workspace` (decision 12).
- Workspace logos. `logoUrl` is available, but the settings row draws no
  images today.

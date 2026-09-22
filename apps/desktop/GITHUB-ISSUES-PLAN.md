# GitHub issues beside Linear

Second tracker on the existing seam. The vocabulary in `issues/issues.rs`
(`Issue`, `IssueDetail`, `IssueState`, `IssueRef`, `IssueQuery`, `IssueFilters`)
stays as it is; GitHub is a module and a variant, as the header of that file
promised. Decisions below were made with the reader and are settled — build
them, don't relitigate.

## Decisions

1. **Auth is `gh`.** Same binary the PR panel shells out to (`github::gh`, make
   it `pub(crate)`). No key, no connect form, nothing in `credentials.json`.
   "Connected" = `gh` resolves and `gh api user` answers. Cache that answer per
   process behind the same `RwLock` bargain `binpath::gh` makes; `recheck_gh`
   clears it.
2. **Identifier is `owner/repo#123`, tag is `#owner/repo#123`, always.**
   GitHub's own cross-repo spelling. Never bare `#123` — it is only meaningful
   relative to a repo and collides with prose. Shape decides the tracker:
   `IssueTracker::of(identifier)` → contains `#` → `Github`, else `Linear`.
   Stated twice (Rust `parse_identifier`, TS `parseIdentifier`), tested twice,
   like the Linear rule already is. Owner/repo case is kept as written;
   `gh` is case-insensitive on them.
3. **Both trackers can be connected, and a switch picks one — never a merged
   list.** One pick, `ade.issueTracker` in local storage, module store
   (`useSyncExternalStore` + `channel`, the `issueGeneration` shape). Drawn as
   filter chips on the Issues page **and** as a header row in the composer's
   `#` menu; flipping either moves both. Only drawn when both are connected;
   with one, the effective tracker is whichever is.
4. **Issues page under GitHub reads one repo at a time.** A Repository picker
   replaces the Team/Project menu; the repo list is every attached project
   with a `github.com` remote (parsed off `git remote -v`, no network). Pick
   persists in `ade.issueRepo`. No repo picked → empty state "Choose a
   repository" with the picker; no repos at all → "Attach a project with a
   GitHub remote". Never auto-read every repo.
5. **Composer's `#` picker under GitHub reads the session's own repo only.**
   Slug resolved from the session `cwd` through a new `github_repo(cwd)`
   command (frontend caches per cwd). No cwd or no GitHub remote → the menu's
   `emptyNote` says "No GitHub repository here."
6. **Writes: status only.** `update_issue` on a GitHub identifier maps state
   `open` → `gh issue reopen`, `completed` → `gh issue close`, `not_planned` →
   `gh issue close --reason "not planned"`. Priority → refuse with "GitHub
   issues have no priority", and the PriorityMenu is not drawn for
   `tracker === "github"` (panel header and page rows).

## Backend

`src-tauri/src/issues/github.rs`, `#[path]`-declared beside `linear.rs`.

- `account() -> Result<TrackerAccount, IssueUnavailable>`: `gh api user
  --jq '{login,name}'`. `user_id` = login, `user_name` = name or login,
  `org_name` = "github.com". Not logged in / no `gh` → `NotConnected`.
- `repo_of(cwd) -> Option<String>`: `git remote -v`, host must be
  `github.com` exactly (reuse `git::remote_host`), path stripped of leading `/`
  and trailing `.git`. Add `remote_path` beside `remote_host` in `git.rs`,
  tested on https, `git@`, `ssh://` and `.git`-less forms.
- `repos_of_projects() -> Vec<String>`: `projects::list_projects()` → `repo_of`
  each → dedup, project order.
- `list_issues(repo, &IssueQuery, limit)`: `gh issue list -R <repo> --json
  number,title,url,state,stateReason,assignees,labels,updatedAt,id --limit N
  --state open|closed`, plus `--assignee @me` / `--author @me` from `scope`,
  `--search <text>` when text. `gh` orders newest-updated first; keep it.
- `get_issue(identifier)`: `gh issue view N -R owner/repo --json
  number,title,body,url,state,stateReason,assignees,labels,updatedAt,id,comments`.
  Transferred issues redirect on GitHub's side, so the node id is stored on
  `IssueRef.id` (it is what `updateIssue` dedups on) but **not** looked up —
  `ponytail:` comment; a `node(id:)` GraphQL read is the upgrade.
- `update_issue(identifier, state_id)` as in decision 6. Unknown state id →
  `Other`.
- `list_filters() -> IssueFilters`: `teams` = one `IssueGroup{id: slug, name:
  slug}` per repo, `projects` = empty, `team_states` = slug → the three
  states. `Issue.team` = slug, so the page's `statesFor` lookup works unchanged.
- Mapping: OPEN → `unstarted` / "Open" / `#1a7f37`; CLOSED+COMPLETED →
  `completed` / "Closed" / `#8250df`; CLOSED+NOT_PLANNED → `canceled` /
  "Not planned" / `#59636e`; state ids `open` / `completed` / `not_planned`.
  Priority always `None`. Labels: gh gives `color` without `#`, add it.
  Assignee = first; avatar `https://github.com/<login>.png` for humans,
  `None` where `is_bot` (the `[bot]` login 404s — CLAUDE.md's PR note).
  Comments: `author.login`, `body`, `createdAt`, `url`.
- Failures: `gh`'s own stderr sentence as `IssueUnavailable::Other`; missing
  `gh` or logged out → `NotConnected`.

`issues.rs`:

- `IssueTracker::Github` (`snake_case` → `"github"`), `credential_key` arm
  (unused, keeps the match total), `IssueTracker::of(&str)`.
- `parse_identifier`: try the GitHub shape first —
  `^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+#\d+` — then the Linear rule.
  `issue_tags` unchanged (token has no whitespace).
- `IssueQuery.tracker: IssueTracker`, `#[serde(default)]` = Linear. Under
  GitHub `team_id` **is** the repo slug.
- `IntegrationsView { linear, github: Option<TrackerAccount> }`;
  `get_integrations` asks `github::account()` only where `binpath::gh()`
  resolves, so a gh-less machine spawns nothing.
- `list_issues`: match `query.tracker`; GitHub with no `team_id` → `Other("Pick
  a repository")`. `get_issue` / `update_issue`: route by
  `IssueTracker::of(identifier)`. `list_issue_filters(tracker)`. New command
  `github_repo(cwd) -> Option<String>`; register in `lib.rs`.
- `expand_tags` / `bare_ref`: tracker by shape per tag; GitHub tags resolve
  through `github::get_issue`, best-effort like Linear's.
- `IssueUnavailable` Display `NotConnected`: "Dray is not connected to an issue
  tracker. Connect Linear in Dray's settings, or sign in to GitHub with `gh
  auth login`."
- `orchestration.rs::link_issues`: `tracker: IssueTracker::of(&identifier)`
  instead of the literal.

Tests: `parse_identifier` both shapes + `#fff`/heading regressions;
`IssueTracker::of`; `remote_path` forms; mapping from committed fixtures
`src-tauri/src/fixtures/gh_issue_list.json` (real capture — `gh issue list -R
monorepo-labs/dray --state all --json …` already returns one OPEN and one
CLOSED/COMPLETED; add a NOT_PLANNED row by hand and say so) and
`gh_issue_view.json` (real capture with comments). **After any filtered `cargo
test`, run a bare `cargo test`** — ts-rs regenerates `events.ts`.

## Frontend

- `events.ts` regenerates: `IssueTracker = "linear" | "github"`,
  `IssueQuery.tracker`, `IntegrationsView.github`.
- `lib/issue.ts`: `parseIdentifier` GitHub alternative (regex above, case
  kept), `trackerOf(identifier)`. `groupIssues(issues, tracker?)` relabels
  `unstarted`→"Open", `completed`→"Closed", `canceled`→"Not planned" for
  github. Tests for both, and a `highlight.ts` round trip with
  `#owner/repo#12 Some title`.
- `lib/issueTracker.ts`: the pick store — `readIssueTracker()`,
  `setIssueTracker()`, `useIssueTracker()`, `effectiveTracker(pick,
  connected)`.
- `components/GitHubIcon.tsx` beside `LinearIcon.tsx` (octocat path, same
  size API). lucide 1.x ships no brand icon.
- `hooks/useIssues.ts`: `keyOf` gains `tracker`; `DEFAULT_QUERY` built from
  the pick and, for github, `teamId` from `ade.issueRepo`; `useIssues(active,
  tracker)` resets `filters` and `query` when the tracker changes;
  `list_issue_filters` takes `{ tracker }`. `issueErrorText`: Linear wording
  only where `kind` is `unauthorized`/`offline` **and** the tracker is Linear —
  otherwise the sentence is the detail.
- `hooks/useIssueSearch.ts`: takes `cwd`; under github resolves the slug via
  `github_repo` (module cache per cwd) and builds `queryFor(text, tracker,
  slug)`; returns `emptyNote` for no slug.
- `hooks/useIntegrations.ts`: `connected = { linear, github }`; App derives
  `issuesConnected = linear || github`.
- `IssuesView.tsx`: tracker chips at the left of the filter row (both
  connected only); `FilterMenu` under github draws one "Repository" section
  from `filters.teams`, no Project section; github empty states per decision
  4; `PriorityMenu` gated on tracker; `Connect` gains one line under the
  Linear form: "Or sign in to GitHub with `gh auth login` — Dray reads GitHub
  issues through the `gh` CLI." `unavailableText` tracker-aware as above.
- `IssuePanel.tsx`: `PriorityMenu` gated; `UNAVAILABLE.not_connected` →
  "Connect a tracker on the Issues page to see this issue."
- `composer/IssueMentionMenu.tsx`: `header` prop → `PickerMenu` gains
  `header?: ReactNode` drawn above the rows; the header is the two chips with
  `onMouseDown={e => e.preventDefault()}` so the editor keeps focus.
  `ChatInput` passes `cwd` into `useIssueSearch`.
- `COPY-ISSUES.md`: every new string, with where and why.
- `CLAUDE.md` Issues section: rewrite the opener ("the implementation says
  Linear" is no longer true) and add one paragraph carrying decisions 1–6 and
  the two traps (bare `#123` refused on purpose; `team_id` is the repo slug
  under GitHub). Keep it to that.
- `apps/cli/skill/SKILL.md`: one GitHub example beside the Linear ones
  (`dray issue link owner/repo#12 --title … --url …`).

## Out of scope, on purpose

- Bare `#123` tags. Uploads on `github.com/user-attachments` (private repos
  need auth; public ones draw as ordinary images). Labels, assignee, comments
  as writes. GitHub Enterprise hosts (`remote_host` reads `github.com` only,
  the PR panel's own limit). A node-id lookup for transferred issues.

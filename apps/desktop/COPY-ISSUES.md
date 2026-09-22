# Issue tracker — every string, for review

Every user-facing string the issue integrations add, with where it is drawn and
why it says what it says. Nothing here is settled: mark up anything and I'll
change it in one pass.

The one rule holding across the whole list: the surface says **issue**, never
Linear or GitHub — except where the reader is being asked about one of them
specifically (a connect form, and a failure that tracker itself caused).
Trackers are pluggable; the vocabulary did not change when the second one
landed, which is the whole of what that rule bought.

---

## Sidebar

**Nav row, below "New task"**

> Issues

Always drawn, connected or not. The page is where connecting happens, so hiding
it until connected would hide its own entrance.

---

## Issues page — a tracker with nothing behind it

**The switch is above this pane, exactly where the list's own row puts it**, so
the page does not rearrange itself between the two states. It is what makes this
pane reachable at all with the *other* tracker connected, and pressing the
disconnected half is how somebody finds out there is a second one.

**One tracker is asked for at a time** — the one the switch is on. The other is
offered under a rule below and only while it is *also* missing: a line pitching
something the reader already has can only read as the app being confused.

### Linear

**Heading** — with Linear's mark beside it

> Connect Linear

**Subtext, under the heading**

> Paste a personal API key with read and write access. A read-only key works too — you just cannot change a status or priority.

Two sentences: what it needs, and what the smaller version of that costs. Write
is named first because the app now does it — the status and priority menus in an
opened issue's header — and a reader who found that out from a menu that failed
would rightly read it as the app being broken.

Read-only is still offered, and second, because it is what somebody wary of
pasting a credential into a desktop app can give. Naming the cost exactly, rather
than warning them off, is what keeps that a small decision: everything on this
page works, and two menus do not.

**Key field placeholder**

> lin_api_…

**Submit button** — idle, then while the key is being checked

> Connect
> Connecting…

**Link below the form**

> Create a key in Linear

**Note under it**, above a rule — the other half of the setup

> Dray reads your issues with this key, and writes only the status or priority you pick. To let the agent read and manage issues in chat, add [Linear's MCP server](https://linear.app/docs/mcp) to your CLI.

Said here and only here. The key fills Dray's own screens and gives the agent
nothing; someone who finds that out later finds it out from a model working off
a one-line title, which is the expensive way. No check behind it — a live health
check was built and removed, since this is setup advice rather than a fault to
report.

Opens `https://linear.app/settings/account/security`. A link rather than
instructions: the path through Linear's settings is theirs to change, and a
stale sentence here is worse than none.

**Refusals, under the field**

> Paste a Linear API key first.

> Linear rejected that key. Check it was copied whole and has not been revoked.

> Could not reach Linear: {detail}

The middle one names the two things that actually go wrong — a paste that lost
its tail, and a key revoked months ago.

**The GitHub half, under a rule below the form** — with GitHub's mark beside
it, and **only while GitHub is not connected either**

> Or sign in to GitHub with `gh auth login` — Dray reads GitHub issues through the `gh` CLI, so there is no key to paste.

Second and quieter, because only one of the two asks anything of the reader:
GitHub's credential is `gh`'s own, so there is no field here and nothing for
Dray to hold. Said on this surface because this is the one with nothing to show,
and somebody who already has `gh` signed in is one relaunch from a page full of
issues without knowing it. `gh auth login` links to GitHub's own manual page for
the reason the Linear key link does: the flow is theirs to change.

### GitHub

**Heading** — with GitHub's mark beside it

> Sign in to GitHub

**Subtext**

> Dray reads GitHub issues through the `gh` CLI and holds no credential of its own, so there is nothing to paste here.

A screen with no field on it should say what is standing in for one. Without
this the pane reads as a form that failed to load.

**Then the two commands, in this order**

> Run `gh auth login` in a terminal, then refresh this page.

> No `gh` yet? `brew install gh`

Login first because a logged-out `gh` is far commoner than an absent one, so the
pane opens on the likelier cure. The install line is **not** optional: without it
the only instruction on screen is a command that does not exist on a machine that
never had the CLI, which is exactly the reader this pane is for. Homebrew because
this app is macOS only, spelled as the PR panel's setup pane spells it.

**The Linear half, under a rule**, and only while Linear is not connected either

> Or connect Linear with a personal API key — the switch above.

It points at the switch rather than repeating the form: the form is one press
away and it is a credential field, which is not a thing to draw twice on one
screen.

**No refusals here**, and nothing to refresh with: Dray runs no `gh` command
from this pane and holds no answer to invalidate. The reader signs in in their
own terminal and comes back.

---

## Issues page — connected

**Tracker chips**, first in the filter row, **always drawn**

The two marks and no words: Linear's, GitHub's, whichever is on filled like a
scope chip. A word would be the widest thing in a row of glyphs, and this is one
of the few places the app names a tracker at all. Their accessible names:

> Linear
> GitHub

First in the row because it changes what every other control in it means — the
scopes and the filter menu narrow *within* a tracker. One tracker connected is
not a choice, so the chips are absent rather than disabled.

The same two chips head the composer's `#` menu, and flipping either moves both:
it is one pick for the whole app, never a merged list. Merging them would put
two unrelated workspaces under one set of headings with no ordering meaning
anything across them, since a Linear issue carries a priority and a GitHub one
does not.

**Scope chips**

> Assigned to me
> Created

The two questions worth one press: what is mine to do, and what did I ask for.
"Assigned to me" spelled out rather than "Assigned", which on its own leaves the
reader to guess assigned *to whom*.

**Under GitHub the second one is different**, because the list is already one
repository:

> Assigned to me
> All

"Created" narrows a list the reader has already narrowed by hand, down to the
handful they happened to open themselves — a smaller question than anybody opens
this page to ask. Where Linear's list is a whole workspace and "everything"
there is a firehose, one repository's open issues is exactly the useful list.

**Search field placeholder**

> Search issues

**Filter menu** (behind the sliders icon; hidden entirely when there is nothing
left to narrow by — a team or project list with one entry is not offered)

> Team
> All teams
> Project
> All projects

**Under GitHub this menu is not drawn at all.** Both of that tracker's controls
stand on the row itself (below): the repository *is* the list rather than a
narrowing of one, and the label filter wears its value the same way. GitHub
Projects are a board an issue is placed on rather than a field it carries, which
is a different query against a different object.

**Label control**, on the row beside the repository — a tag glyph and the word
until one is picked, then that label's own colour as a dot beside its name

> Label
> All labels

Labels belong to the *repository*, so the options are re-read whenever the
repository pick moves, and a repository pick clears the label with it. Drawn
only where the repository has labels. Linear has labels too and is deliberately
not offered them: its narrowings are team and project, and a third axis would be
a control added to the tracker that needs it least.

**State switch**, on the left beside the scope chips, GitHub only — the same
track-and-thumb switch the trackers use, with words rather than glyphs

> Open
> Closed

**Repository control**, on the filter row, wearing GitHub's mark and the
repository's name on its face — lit like a scope chip once set

> Choose a repository
> dray

The value *is* the answer to "what am I looking at", which is why this one wears
its name where the controls beside it are glyphs. Buried in the filter menu it
was both invisible when set and unfindable when not. **The owner is dropped from
the trigger**: it is the same word for most of the list and is only ever needed
to tell two same-named repositories apart, which is a question asked where the
pick is made, and the menu is one click away. The rows are `owner/repo`,
one per attached project with a `github.com` remote, and there is no "all
repositories" to clear to — a number is only addressable within one.

**What the page *is* stays left; what narrows it goes right.** The scope chips
are a pick out of a fixed pair, where the controls on the right each carry a
value and grow as wide as it is — interleaved, they pushed the chips a different
distance from the edge on every repository. Refresh closes the row without
joining that group, acting on the page rather than narrowing it.

The rows and the panel both draw a label in the colour the repository gave it
— a label has no meaning apart from that colour, unlike a status, which folds
onto a fixed vocabulary. A row draws at most three, and drops them on a narrow
pane: past three they stop being information and start being a second title.

**Only two settled headings under GitHub**, and no Cancelled. GitHub files "not
planned" as a *reason* on its one closed state rather than as a state of its
own, so a heading for it was a permanent empty row and a menu row for a
distinction nothing else here reads. A not-planned issue is closed, and that is
what the page says.

**Group headers** — the state buckets, in this order, count beside each

> In Progress
> Triage
> Todo
> Backlog
> Done
> Cancelled
> Other

Grouped on the state's *kind*, not its name, so a team that calls its in-progress
column "Shipping" still lands under In Progress. "Other" only ever holds a state
Linear added that we don't model.

**Under GitHub there are no headings at all.** It has two states where this
names six, so grouping by them drew one list under an "Open" heading with a
permanently-collapsed "Closed" beneath it — a switch wearing a costume. The
switch is on the filter row instead (above), and the rows are drawn flat.

> Open
> Closed

Closed work is a different question rather than the tail of this one, so asking
it swaps the list rather than growing it. **And there is no Cancelled**: GitHub
files "not planned" as a *reason* on its one closed state rather than as a state
of its own, so it is neither a heading nor a status-menu row. A not-planned
issue is closed, and that is what the page says.

**Done and Cancelled are always drawn and always start closed** under Linear,
and nothing is fetched for them until one is opened. Until then they carry no count — a zero
would be a claim, not a blank. While the read is out:

> Reading…

And when a group turns out to hold nothing:

> Nothing here.

**Empty list** — one per way of coming up empty, since collapsing them would
leave the reader unable to tell a filter that matched nothing from a half of the
workspace that is genuinely clear

> No issue matches that.
> No closed issues in this repository.
> Nothing closed is assigned to you.
> Nothing you filed is open.
> No open issues in this repository.
> Nothing assigned to you.

**No repository picked yet**, the GitHub half's own resting state — not a
failure and not a read that came back empty, so it sits where the reading line
would and nothing is fetched behind it. **The repositories themselves are drawn
under it, one clickable row each**: a line telling the reader to choose, with
nothing on screen to choose from, is an instruction they then have to work out
how to follow.

> Choose a repository to see its issues.

**And where there is none to choose**, because no attached project has a
`github.com` remote — the cure is attaching one, which happens elsewhere, so
this one stays a sentence and names what makes a project count

> Attach a project with a GitHub remote to see its issues.

**Failed read, above the list** (what was already read stays on screen)

> Linear rejected the saved key. Disconnect it in Settings, then paste a new one.
> Could not reach Linear.
> No issue tracker connected.

**The same three under GitHub**, where naming a stored key would send the reader
to fix a credential they never pasted — there is nothing in Settings to
disconnect, and `gh` is where the fix is

> GitHub refused that read. Sign in again with `gh auth login`.
> Could not reach GitHub.
> Not signed in to GitHub. Run `gh auth login`.

**And one that is neither tracker's**, answered when the GitHub half is asked
for issues with no repository named — reachable from the CLI rather than from
this page, which draws its own sentence above instead

> Pick a repository

**Icon labels** (screen readers and tooltips)

> Refresh   ⌘R
> Filters

Refresh sits at the far right of the chip row, not among the chips: it acts on
the whole page rather than narrowing it. ⌘R reaches it while the page is up, the
same chord that re-reads the right panel — it means "re-read what I am looking
at", never a specific thing.

---

## Composer

**Placeholder, new task, tracker connected**

> Describe a task. #issues. @files. /skills and commands.

**Placeholder, new task, nothing connected**

> Describe a task. @files. /skills and commands.

`#` is named only where it would do something. Offered to someone unconnected,
it teaches them the app is broken rather than that they haven't set it up.

**Picker header, on `#`**

> Issues

**The tracker chips ride that menu's own header**, where both are connected —
the same two marks the page draws, and pressing one moves the page too.

**Under GitHub the picker reads this session's own repository and nothing
else**, since the composer already knows which one it is in where the page has
to be told — and it reads **every** open issue there rather than only those
assigned to the reader, since one repository is already a narrow enough list and
assigning yourself an issue is a habit far fewer repositories have than Linear
workspaces do.

**An empty answer is a sentence, never a closed menu.** This is the opposite
reading to the `/` picker's, and the difference is that this menu never opened:
a tracker with nothing to list was indistinguishable from `#` being broken, and
it took the tracker chips with it — the one control that reaches the tracker
that *does* have issues.

> No GitHub repository here.
> No open issues in this repository.
> Nothing assigned to you.
> No issue matches that.

Three different facts and four sentences, because collapsing them would leave
the reader unable to tell a repository this app cannot find from one that simply
has no open issues: the first is fixed by switching tracker, the second by
nothing at all. Withheld while a read is still out, where the placeholder rows
already say the list is coming.

**The row's date is when the issue was filed**, not when it last moved.
"Updated" is a fact about the conversation rather than about the work, and
anything automated touching an issue says more about the bots than about it.
The opened issue's own header still reports the last move, which is where that
question is actually asked.

**And the list is ordered by it, newest first**, or the column would be a date
in no order at all. GitHub's is exactly that, flat. Linear's still groups by
state and ranks by priority inside a group — that is what the headings are for —
so there the dates run in order *within* a group rather than down the page.

**A row says whether anybody has started**, both trackers: a pull-request
glyph and the number, or a count where there are several.

> #143
> 2 PRs

It is the one thing on the row that is not about the issue but about the work,
and it is what the reader scanning a list is looking for — on Linear especially,
where the status glyph says In Progress whether a PR exists or not. Inert, like
the labels and the project chip beside it: a single number could open that PR
and a count could not, and a chip that is a link on some rows and text on others
is worse than one that is never a link. ⌘-click on the row still leaves for the
tracker, where they are listed.

The two trackers answer it differently and both answers are narrow on purpose.
GitHub's is `closedByPullRequestsReferences` — what its own sidebar calls
Development, the PRs that would close the issue — rather than every PR that
happens to mention it. Linear's is the issue's attachments, filtered to
`github.com/<owner>/<repo>/pull/<n>` by **URL** and not by `sourceType`, which
is Linear's own word for where an attachment came from and is a different string
per integration. Enterprise GitHub is not matched, so the cost there is a chip
missing rather than a wrong one.

**No assignee avatar under "Assigned to me".** The answer is the reader on every
row there, so their own face down the edge of a list they asked for by name says
only what the lit chip above it already does. The creator beside it is a
different person and stays.

**A GitHub row names who filed it**, avatar and login, after the title. It is
the person field that always has an answer there — an issue is assigned to
nobody far more often than not — and the row has the width for it, having given
up the priority slot and the status glyph. A Linear row keeps both of those and
an assignee besides, so it says nothing about the creator.

**A GitHub row carries no status glyph.** Linear's six states make it a reading
as well as a control — which of the six this row is on — where GitHub has two
and the switch above has already picked one, so every glyph in the list said the
same word the control at the top of it did. Closing an issue moves to the
Details pane, which carries the same menu.

**Rows name the number alone under GitHub** — `#121`, not
`monorepo-labs/dray#121`. Every row is in the one repository, so the slug would
spend the narrowest column saying the same thing over and over. The *tag* that
lands in the text keeps it whole, since a prompt has no such context and the
identifier there is an address.

---

## Right panel — Issue tab

Two things open this: a session tagged with issues, and a row picked on the
Issues page. Same panel either way — it describes whatever the main column is
showing. A page pick has no session behind it, so it draws no Remove button.

**Tab label**, over a session

> Issue

**Heading**, over a picked issue — where the tab row would be, since there is
only one thing in the pane and nothing to switch to

> Details

**No issue tagged**, and barely ever seen: the tab is drawn only where a session
has a link, so this is the frame between unlinking the last one and the tab
going

> No issue on this session.

It names no cure, and that is the point. A `#` in the composer is a *mention* —
it reaches the model and draws as a button in the bubble, and records nothing.
Linking is the agent's, through `dray issue link`, so a sentence here telling
the reader to do it by hand would be sending them after work they never had.

The status is drawn as a glyph at the head of each row and **its name appears
nowhere** — the row already says it, and a word under the glyph saying the same
thing was the fact twice. The glyph keeps an `aria-label` so a screen reader
still gets the name.

**Uploads inside the description**, where Linear puts them. Images draw as
images; anything else draws as a card with its name, its size, and a download
glyph that appears under the cursor. While the bytes are on their way, and when
they could not be fetched:

> Loading…
> Unavailable

**While a row is open**

> Reading the issue…
> Could not read this issue.
> No description.

**Failed read**

> Connect a tracker on the Issues page to see this issue.
> Linear rejected the saved key. Disconnect it in Settings, then paste a new one on the Issues page.
> Could not reach Linear.

The first names neither tracker, because this row can be either: a session
carries both kinds of link, and the page is where both are connected.

**A panel row names the number alone too**, `#108` rather than
`monorepo-labs/dray#108`: the slug is most of a narrow panel's width spent on
the half that is the same for every issue in the repository, and the panel draws
one issue at a time.

**Meta line**, under the title and above the labels — who filed it first,
because it is the one that always has an answer. A GitHub issue is assigned to
nobody far more often than not, so a line opening with the assignee opens with a
blank on most rows.

> {yogesh} opened this

**Priority is absent on a GitHub row**, not drawn as "no priority". GitHub has
no priority field at all, so a glyph there would say the work is unprioritized
where the truth is that the tracker never asks — and the menu behind it could
only refuse every pick. The status menu stays: it offers the three GitHub has.

**Row buttons** (hover, and their tooltips)

> Remove {DRA-53}
> Remove {DRA-53} from this session
> Open {DRA-53} in the browser

---

## User message

An issue tag in a sent message is a button. Its tooltip:

> Open {DRA-53} in {linear.app}

The hostname is read off the issue's own URL rather than written here, so a
self-hosted tracker names itself.

---

## Main column header

**While the issues page is up**, where a session would otherwise be named

> Issues

The page fills the column but is not a session and never becomes one, so the
header would otherwise sit at "New session" over a list of issues.

---

## Settings dialog

Drawn **only when something is connected** — connecting happens on the Issues
page, and a settings row offering to connect something the reader has never seen
is a row they cannot judge.

**Label**

> Issue tracker

**Subtext** — with Linear's mark beside it

> {Acme}, as {Yogesh}

**Button**

> Disconnect

**Once pressed**, the row asks before it acts — the key is not recoverable from
here, so taking it back means a trip to Linear for a new one.

> Dray will forget the key. Sessions keep the issues they are tagged with.

> Cancel
> Disconnect

---

## CLI — `dray`

**`dray new --issue <ISSUE>`**

> The issue this work is against, like DRA-53. Repeat for several.

**`dray issue`**

> Tag a session with the issue its work is against.

**`dray issue link` / `dray issue unlink`**

> Tag a session with one or more issues.
> Remove issues from a session. The issues themselves are untouched.

**Its flags**

> The issue's title, so the tag reads as more than an identifier.
> The issue's web address, so the tag becomes a link.

**Refused when they would describe more than one issue**

> --title and --url describe one issue, so name one

**Refused when nothing names a session.** The session is optional so that the
documented call names no environment variable, which Claude Code refuses inside
a worktree. Run from a person's own terminal there is nothing to fall back to,
so the sentence names the cure rather than guessing at a session.

> no session named, and DRAY_SESSION_ID is not set: name the session, as printed by `dray ls`

**Refused when a session is named and no issue is.** The same sentence the app
answers with, so the two cannot drift into two ways of saying one thing.

> name at least one issue, like DRA-53

**A GitHub issue is named the same way**, in GitHub's own cross-repo spelling:

> dray issue link owner/repo#12 --title "…" --url "…"

Never a bare `#12`. A number alone is meaningful only relative to a repository,
and a prompt is full of them — so a tag that linked one would file a session
under whichever repo happened to be nearest, which is a wrong link that reads
exactly like a right one. The shape is also what says which tracker a link
belongs to, since `dray issue link` asks the tracker nothing.

**After a link or unlink**, the session's whole issue list, one per line:

> DRA-53: Add issue tracker integration

**When there are none left**

> No issues on this session.

---

## What a tag looks like, everywhere

One shape, whoever wrote it — picked from the composer's `#` menu, typed by
hand, or appended by the CLI's `--issue`:

> #DRA-53 Add issue tracker integration
> #monorepo-labs/dray#121 Add oh-my-pi as a fourth harness

The title is in the text rather than drawn beside it. That is what lets the
model read it, the transcript paint it, and the composer's overlay stay in
register with the textarea underneath.

The identifier is whatever that tracker calls the issue, and its shape is what
says which tracker it is — a `#` inside it is GitHub's, since a Linear
identifier is a team key and a number and holds none.

---

## Settings dialog — the GitHub row

Nothing. There is no row, no key and no Disconnect: the credential is `gh`'s
own, so Dray has nothing to forget and nothing it could take back. Signing out
is `gh auth logout` in the reader's own terminal, and the Accounts tab beside
this already says who `gh` is signed in as.

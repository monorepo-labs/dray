# Issue tracker — every string, for review

Every user-facing string the Linear integration adds, with where it is drawn and
why it says what it says. Nothing here is settled: mark up anything and I'll
change it in one pass.

The one rule holding across the whole list: the surface says **issue**, never
Linear — except where the reader is being asked about Linear specifically (the
connect form, and a failure Linear itself caused). Trackers are pluggable; the
vocabulary should not have to change when a second one lands.

---

## Sidebar

**Nav row, below "New task"**

> Issues

Always drawn, connected or not. The page is where connecting happens, so hiding
it until connected would hide its own entrance.

---

## Issues page — nothing connected

**Heading** — with Linear's mark beside it

> Connect Linear

**Subtext, under the heading**

> Paste a personal API key with read access. Dray only reads — it never changes an issue.

Two sentences, the shape the analytics row uses: what it needs, and what it will
never do. "Read access" is the whole point of the first — it is the smallest
thing that works, and saying so makes pasting a credential into a desktop app a
smaller decision. The second is what stops anyone expecting their issue to move
to In Progress on its own.

**Key field placeholder**

> lin_api_…

**Submit button** — idle, then while the key is being checked

> Connect
> Connecting…

**Link below the form**

> Create a key in Linear

**Note under it**, above a rule — the other half of the setup

> This key is read-only, and it is for Dray. To let the agent read and manage issues in chat, add [Linear's MCP server](https://linear.app/docs/mcp) to your CLI.

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

---

## Issues page — connected

**Scope chips**

> Assigned to me
> Created

The two questions worth one press: what is mine to do, and what did I ask for.
"Assigned to me" spelled out rather than "Assigned", which on its own leaves the
reader to guess assigned *to whom*.

**Search field placeholder**

> Search issues

**Filter menu** (behind the sliders icon; hidden entirely when there is nothing
left to narrow by — a team or project list with one entry is not offered)

> Team
> All teams
> Project
> All projects

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

**Done and Cancelled are always drawn and always start closed**, and nothing is
fetched for them until one is opened. Until then they carry no count — a zero
would be a claim, not a blank. While the read is out:

> Reading…

And when a group turns out to hold nothing:

> Nothing here.

**Empty list** — three cases

> No issue matches that.
> Nothing you filed is open.
> Nothing assigned to you.

**Failed read, above the list** (what was already read stays on screen)

> Linear rejected the saved key. Disconnect it in Settings, then paste a new one.
> Could not reach Linear.
> No issue tracker connected.

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

> Connect Linear on the Issues page to see this issue.
> Linear rejected the saved key. Disconnect it in Settings, then paste a new one on the Issues page.
> Could not reach Linear.

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

**After a link or unlink**, the session's whole issue list, one per line:

> DRA-53: Add issue tracker integration

**When there are none left**

> No issues on this session.

---

## What a tag looks like, everywhere

One shape, whoever wrote it — picked from the composer's `#` menu, typed by
hand, or appended by the CLI's `--issue`:

> #DRA-53 Add issue tracker integration

The title is in the text rather than drawn beside it. That is what lets the
model read it, the transcript paint it, and the composer's overlay stay in
register with the textarea underneath.

# Design notes

Why Dray's surfaces are shaped the way they are. [CLAUDE.md](../../CLAUDE.md) holds the
operating manual — protocol, git mechanics, conventions, traps; this file holds the
reasoning behind the visual and interaction design.

**Read this before restyling anything, changing window chrome, or reworking a panel,
card, row or button.** Most entries record an alternative that was tried and rejected,
so changing one back is usually redoing work rather than improving it. Nothing here is
load-bearing for correctness — the traps that break the app silently live in CLAUDE.md.

Same writing rules as CLAUDE.md: why, not what. Cut any word doing no work.

## Window, chrome and the radius scale

**Almost everything is a rounded square.** Not sharp rectangle, not pill. One radius scale from `--radius: 0.625rem` in [App.css](src/App.css): composer card + drop overlay `rounded-2xl`, dialogs + cards `rounded-xl`, menus + buttons `rounded-lg`, menu items + small tiles `rounded-md`. `Button`'s `size` variants already carry right rung — `icon-sm` = `rounded-[min(var(--radius-md),12px)]` — so **icon button need no radius class at all**, and `rounded-full` on one make it single circle in row of squares.

**Filled button carry shadow; chrome don't.** `--shadow-button` = `0 1px 4px` straight down, no spread, on `default` variant only — on dark palette filled button and its background = two flat fields, so without it only thing saying "button" is fill. x offset zero deliberately: horizontal offset read as light source rest of app don't have. `ghost` and `outline` stay flat.

**Shortcut belong in real tooltip, not on `title`.** System tooltip can't hold keycap and look like OS not app. Use `Tooltip`/`TooltipContent` with `Kbd`/`KbdGroup` (see `ModelSelector`, `ComposerToolbar`), put plain name on `aria-label`. Reserve `title` for text app is _truncating_ — shortened path, clipped name — where tooltip restore information layout removed, not add information reader already have.

**Window is glass, and body's fill = only hole in it.** Vibrancy set in [tauri.conf.json](src-tauri/tauri.conf.json), not Rust: `windowEffects.effects: ["sidebar"]` put NSVisualEffectView behind webview, `transparent: true` let webview show it. Second flag drag `macOSPrivateApi: true` and `macos-private-api` Cargo feature with it, costing App Store eligibility Dray never wanted. Effect whole-window, so material picked for blur amount only; tint = ours.

Feature arrive late, so **first `pnpm tauri dev` after turning this on need manual restart** — CLI patch `Cargo.toml` when it read new config, but already-spawned app predate relinked binary, and `transparent` compile out entirely without feature. Read as "vibrancy don't work", not as stale build.

Only body punch through, and that work because nothing else paint edge to edge: sidebar carry no fill of own, and right panel's `--sidebar` = `--background` under another name, so it must go **transparent** rather than tint same pixels twice (two 62% layers = 86% one). Alpha on `--vibrancy-alpha` = whole dial.

Two placement facts, both failure looking like taste. Attribute stamped on `<html>` in [index.html](index.html)'s pre-paint script, not on mount — React land frame or two in, long enough to watch app open opaque and turn to glass — and gated on macOS. Rule itself live on **`body`**: palette blocks (`[data-theme][data-mode]`) out-specify any `html[data-vibrancy]` selector, so `--sidebar` override on `:root` silently lose.

**Fullscreen drop it, in CSS alone.** Nothing behind fullscreen window but space's own black, so material go flat grey and read as theme washing out. [useGlass](src/hooks/useGlass.ts) take `fullscreen` off `useFullscreen` and remove attribute. Native effect left applied: invisible under body's own fill, and clearing it need Rust round trip on every resize to buy nothing. What dropping it now cost = only *what* surfaces layer over, see below.

**Window drag need permission _and_ `deep`, and both fail silently.** `titleBarStyle: "Overlay"` mean app draw own titlebar, so `h-(--titlebar-h)` row in `App`, `Sidebar` and `RightPanel` = whole of what user can drag by.

Permission first: `core:default` grant `allow-internal-toggle-maximize` but **not** `core:window:allow-start-dragging`, so it named explicitly in [capabilities/default.json](src-tauri/capabilities/default.json). Without it ACL reject every `start_dragging` call and report nothing — drag do nothing while double-click-to-maximize keep working, reading as "drag region wrong" not "permission missing". Capability compiled into binary, so change need Rust rebuild; frontend HMR show old behaviour.

Then value: bare `data-tauri-drag-region` = **self only**, drag start only where pointer hit that exact element ([drag.js](https://github.com/tauri-apps/tauri) walk composed path), so every label inside row = dead strip in titlebar that look uniform. Use `"deep"` on row and put attribute nowhere else — Tauri stop walk at any clickable element (`A`, `BUTTON`, `INPUT`, `role`, `tabindex`) carrying no attribute of own, so toggles and tabs block on their own and need no opt-out. `="false"` = hard block, for element that must not drag though nothing clickable in it.

## Transparency, and what surfaces sit on

**Vibrancy = macOS flavour of transparency, not second one.** Everything above describe one way of answering "what is behind these surfaces", and it only ever had one answer: the desktop. That answer die in fullscreen, and outside macOS never existed — so app went flat in both, which read as theme washing out rather than as effect.

Second answer = **colour theme own**. `--backdrop-top`/`--backdrop-bottom` what body paint edge to edge. Windowed on macOS they tint real desktop (`color-mix` at `--vibrancy-alpha`), everywhere else they *are* what surfaces sit on. Same layered look, no OS involved.

**Windowed always translucent, and fullscreen answered by theme not by reader.** Windowed there a desktop behind window and nothing to decide. Fullscreen have nothing behind it, so whether surfaces still worth layering depend entirely on whether *that theme's backdrop* worth layering over — fact about palette, not taste about window. So `flatInFullscreen` sit on theme and setting went away. It shipped as switch for about an hour: it ask reader question belonging to theme, in dialog, about state they not in.

Field = **opt-out**, and shape is rule: theme keep layering by saying nothing, so forgetting give theme that look right rather than one going flat with no clue why. Default opt out — its backdrop flat near-black, so with nothing behind fullscreen window its veils have nothing to sit on and only cost contrast.

**Two stops, never one colour, and flat theme = gradient whose end agree.** One code path for both, so `body` never ask which kind of backdrop it hold. Every shipped theme flat today — both stop fall back to `--background` — so machinery currently carry no gradient. Kept anyway, because rule for one that want gradient already established and hard-won: stops must share **exactly** one lightness and differ in hue alone. Gradient carrying lightness ramp read as top of window being lit, not as depth, and that true whatever the hues.

**Vibrancy selector carry `[data-transparency]`, and that where two-veils question get answered.** Token set = *same declarations* vibrancy block already carried, so both on set each token once rather than veil a veil. Gate cannot fail today — `useGlass` only add vibrancy while windowed, where transparency unconditional — and written down anyway: rule holding because of a hook = one edit from not holding.

**`--composer` and `--popover` deliberately not veiled**, and each for reason already written down elsewhere in this file: composer have handoff row parked behind it, popover float over sidebar that have no fill. Both were *existing* fixes for exactly this class of problem, and token set that veil them undo both silently.

**Background belong to theme, and separate axis for it was tried and removed.** Picker choosing backdrop apart from palette cannot reach `--composer` — that one must stay opaque fill — so neutral palette on tinted backdrop put grey slab along bottom edge of window, permanently. Reaching it mean backdrop axis overriding palette token, at which point two axes not independent and only thing justifying split gone. Tell was that Slate didn't have bug: it declare own `--composer`.

**Two ways to write theme, one place they meet.** Derived one = `--hue` + `--chroma`: fixed lightness per rung times per-step multiplier, so theme that is one hue cost two numbers. `--chroma: 0` collapse every `calc()`, which is why Default stay exactly greys it always was (verified: identical pixels before and after). Multipliers taper at both end — chroma reading as colour at `--card` read as *fault* on near-white foreground. **Ported theme not one hue**, so it name its rungs outright instead. Both route end at same alias, and alias = what keep either honest: `--card`, `--popover` and `--composer` all `var(--surface-card)`, so theme cannot set one and forget another. Not hypothetical — earlier pass put grey composer on tinted page exactly that way.

**Ported theme take surfaces and text accents, and stop there.** Catppuccin and Gruvbox name their own background, card, muted, foreground, ring, and the three accents that mark words in prose (`--accent-command`, `--accent-mention`, `--accent-thinking`) plus their own red. `--accent-merge` **not** among them: that button act on GitHub, and matching colour it have there = most of what make it recognisable as same button, so colour is the meaning and theme don't get to repaint it. Border likewise stay mode ramp's — `oklch(1 0 0 / 10%)` and its black twin work over any palette, where ported hex would have to be re-picked per theme to say same thing. Credit live in root [README](../../README.md), and test fail if ported theme ship without one.

**Third-party widget taking its own `theme` need telling too.** `thinking-orbs` resolve `auto` off `data-theme="dark|light"`, and this app stamp *palette* name there with mode on `data-mode` — so `auto` never work here and every orb was pinned `theme="dark"`, true right up until light mode. [Orb](src/components/Orb.tsx) = wrapper feeding it `resolvedMode`, and it exist so reason live once: six call site had copied pin along with element, and seventh would have too.

**No hardcoded `oklch(1 0 0 / N%)` in a component, ever again.** Composer card, picker frame, attachment tile and picker highlight all carried white inline, written back when dark was only mode — and every one vanished in light, silently. Highlight worst: row arrow key sat on simply stopped being marked. Cure = token that flip with mode. `--veil-*` for fill, `--hairline`/`--hairline-strong` for edge (6%/8%), `--border` for 10%. Reach for one of those; inline alpha = same bug again.

**Light veil not same percentage as dark one.** Same alpha move fewer perceptual step over near-white page than over near-black. Measured on picker's own highlight: 8% black gave 19 level of separation where dark's 11.5% white give 28, so light `--veil-strong` = 10%. Pair tuned, never mirrored.

**Light mode = second palette, never filter.** Rungs *reorder*, not flip: raised surface in light sit lighter than page, where in dark it sit darker, so `--surface-raised` swap side of `--surface-card`. Catppuccin show it plainest — Latte's `base` = its lightest token while Mocha's = near its darkest. Veils flip white→black in same breath, and that single thing = what make light more than inverted ramp: white veil on light page is invisible. Accents move long way down in lightness too, since 0.82 yellow on white page = highlighter mark not word.

**Theme without light palette say so, and row stay drawn.** `darkOnly` = opt-out like `flatInFullscreen`, so ported theme arrive with both by saying nothing. Default set it — its light side unbuilt, not unwanted. `modeFor` force dark on write *and* on first read, because `[data-theme="default"][data-mode="light"]` match no block and app fall through to light ramp's own neutrals: legible, but not theme anyone picked and nothing on screen would say why. Settings row therefore **disabled with reason**, not hidden — vanishing row read as setting app forgot, and sentence under it = only place reason can be said.

**Mode = three segment, not switch.** System/Light/Dark. Switch can only ask light-or-dark, leaving `system` reachable from nowhere — and it the one that keep following OS after being set. Drawn off `mode` as *chosen*, never `resolvedMode`, since whole point of System = it read Dark today and Light tonight. Dark-only theme disable **whole group** rather than drop its light segment: two segment where there were three read as broken control, and `system` unofferable there anyway.

**`--sidebar` = `transparent` unconditionally now, not `--background` under another name.** Sidebar read as part of page, and honest way to say that = let page show through. Old way held only while every backdrop flat: against gradient, flat sidebar draw visible seam down window at x where two furthest apart.

## Transcript, cards and the right pane

`header` deliberately unrendered — chip-sized label model write alongside each question ("Indentation" over "Tabs or spaces?"), which read as heading for section that isn't there. Card carry no border or fill either: choices have own.

**Settled `AskUserQuestion` row show only answer.** Its arguments = questions and options reader just answered on card, so `ToolCall` drop input body for it entirely. Its result keep no code box and lose mono font other results carry — it one tool result harness write as sentence not program output.

**Right pane = one frame with tabs, not one panel per view.** [RightPanel](src/components/RightPanel.tsx) own `<aside>`, border, tab row; `ChangesPanel` and `SubagentPanel` = bodies rendering inside it, carry no chrome. `AppShell` have single `panel` slot, so two self-framing panels could only ever be mutually exclusive with two booleans deciding it. Tab row `h-(--titlebar-h)` and carry drag region itself. No close button: `PanelToggle` and ⌘E both close it, matching ⌘B for sidebar. Toggle exported from `RightPanel` but rendered by `App`, because pane not exist before session do and button have to outlive it.

**Changes glyph = plain foreground, not command yellow.** Yellow = app's "this is for you", colour of session standing still behind question. Turn having touched file neither warning nor thing to answer. PR glyph keep its emerald: that one say state of work.

**Toggle double as changes indicator.** With pane closed and last turn having changed tree, it draw git glyph instead of panel one and its click open _changes_ tab not whichever tab last used — glyph opening something else = lie. ⌘E stay plain toggle: show nothing, so promise nothing. Signal = `turnChangedTree`, cost no git call — both sides of range content-addressed tree ids, so ids that differ _are_ changed tree. Reading panel's own file list instead not work: `useChanges` pause while hidden, exactly when indicator have to be right.

**No row in changes list open by default.** List = answer to "what did this turn touch", and auto-opening one file by position put arbitrary diff above that list and push rest off screen.

## PR panel

**Tab called `PR`, and it lead when PR is open.** Short form what anyone working on one call it. `tabOrder` put it first when session have **open** PR (draft count, being `OPEN` with `isDraft` set) — at that point session's work about landing, not about this turn. Merged or closed PR don't promote: it record, not something to act on.

Last turn changing tree **don't** enter into it. Changes describe one turn and superseded by next; PR = state of work. Toggle's own click still set tab to match glyph it drew, and that now only thing `handleTogglePanel` do.

**⌘⇧[ / ⌘⇧] step tab, and legend drawn not hidden.** Step over `tabs` (what `tabOrder` return) not `PANEL_TABS`, so session with no PR tab cycle two and never land on undrawn one. Keycaps sit **right after tabs**, no label, and refresh button take `ml-auto`. Three cap not four — `[ ]` = one key with two end. Deliberate exception to app's tooltip rule: chord for row of two or three tab = one nobody go looking for.

**Panel own no header strip.** PR count ride tab's own badge — same place subagent count sit — and refresh button belong to frame.

**Badge count leave merged PR out** (`prBadgeCount`). Every other state have something reader can still do — open one merge, draft go ready, **closed one reopen** — and merged one have nothing, so counting it inflate badge that exist to say how much still live. It stay in list either way: list = record, badge = workload.

**Single PR not collapsible, and draw no chevron.** Disclosure arrow that can only ever point down = affordance for nothing. Header become plain label rather than button, and lose hover fill with it.

**One refresh button, in tab row, owned by frame.** It mean same thing on every tab, so it sit in same place rather than once per panel; active tab decide what it re-read. Subagents get none — nothing to fetch, and button that do nothing worse than no button. Both panel bodies therefore presentational and **their hooks live in `App`**: `useChanges` moved up beside `usePullRequest` for exactly this.

**Panel = list of collapsible row, same shape as changes panel.** Row zero open by default, and backend's sort what make that free: it already the open one. Each row carry `+A −D` from PR's own `additions`/`deletions`, same figures and colours changes panel use. Selector-chip version tried first and dropped: it made single-PR case carry control that couldn't be used, and hid every other PR's size behind a click.

**Comments and reviews = one timeline, oldest first.** Two lists on wire, but bot's reply to review only make sense next to it. Reviews carry node id not URL, so thread they belong to = closest honest link.

**Nesting drawn with rule, and nothing inside collapse.** Indent alone not enough — anything at body's own margin read as another comment — so nested column hang off `border-l` one indent in, avatar smaller and name muted. Second disclosure inside first = click to find out there was nothing to find. File comment lead with **file**, which what make one worth opening at all.

**Verdict, base and action = one row.** Verdict two words, base two more, button belong beside verdict it depend on rather than under it. `detail` only part still wrapping to own line, because it sentence and only appear when something wrong.

**Head branch not shown.** It session's own branch, named in window header two inches away. Base = half not on screen anywhere else, so `into main` alone — and it also what tell two PRs from one branch apart.

**Sections separated by space, not by rules.** Three horizontal lines across 32rem pane read as table of contents for page holding three short lists.

**Merge button green, and it GitHub's green not app's emerald.** `--accent-merge` = only place app use it. Primary fill on this palette near-white, which made **least reversible control on pane also brightest thing on it**; green what same button is on GitHub, so it recognisable before it read. No icon on it either — label already say "merge".

**Seam light, not dark, and blurred.** `--accent-merge-seam` = `inset 1px 0 1px oklch(1 0 0 / 10%)` — whole shadow in token rather than colour alone, so blur travel with it. Dark line on green fill read as gap **cut through** button where light one belong to it. 1px blur soften it from drawn rule into edge catching light.

**Split button = one rectangle with seam, not two buttons pushed together.** Radius and shadow belong to *pair*, so they sit on wrapper and each half drop its own (`shadow-none` in `MERGE_FILL`, wrapper carry `--shadow-button`). Seam itself = `inset 1px 0 0` on right half: border there would be line of third colour across single fill.

**Merge button never `disabled`.** Disabled button explain nothing and cannot be hovered for reason. It stay clickable at reduced strength and readiness line beside it = answer. Dim apply to *wrapper*, so both halves fade together.

**Check row take no hover fill.** It fact with link on it, not list item to pick from. Cursor still `pointer` where row have destination, and comment row carry one too — collapsed row give no other sign it open.

**Every comment collapsed, avatar in place of icon.** List where some row open and some closed read as accident not rule, so all start closed and first line of body (heading marks stripped) stand in for rest. Verdict carried by **coloured word** in closed row — `approved`, `requested changes` — so one thing worth knowing already there. Author's picture replace icon that used to sit there: it say *who* in same space, where column of identical speech bubbles said nothing. Comment rows sit in `gap-2` column where check rows don't: checks = dense column of one-line facts, comments = separate things people said. Check row keep state glyph **and** take avatar second — state why anyone look at list, so it keep left edge. Avatar fall back to initial and cover it on load, so slow or missing image never leave hole.

Glyph sit **beside rail, ahead of title**, and take **no room when absent** — unlike rail next to it, which hold its slot. Two differ because rail come and go on *same* row as agent work, where branch either have PR or don't: row that never get one would otherwise pay for mark forever. Rail keep outer edge, since it "over to you" and clear when reader deal with it, where this standing fact about branch. Emerald for open, muted `GitPullRequestDraft` for draft, since draft = work not asking to land yet. `title` attribute rather than tooltip: decoration on row that itself a control, and tooltip open every time cursor cross list.

**Toggle's PR glyph count draft, and draw draft's own shape.** `hasOpenPr` = any `state === "OPEN"`, which draft satisfy. `draft` prop true only where **every** open PR is one — session carrying draft beside real PR have something asking to land. Glyph keep emerald either way: shape carry distinction, colour carry "there is something here".

**Panel toggle draw PR over changes.** Two indicators = same promise, so only one can be drawn and PR win: it tab that open first, it state of *work* rather than of last turn, and it survive next prompt landing where changes mark don't. Glyph = **`text-emerald-500`, not `--accent-merge`**: that token is button *fill*, dark enough to carry white text, and at 1.5px stroke on dark background it all but disappeared.

**Collapsed preview = plain text, so markup come off first.** `firstLine` strip heading marks, emphasis, and link syntax keeping only its text — `(https://…)` half usually longer than words around it and not clickable in truncating span anyway.

**PR body deliberately unrendered.** It one thing on panel reader wrote themselves, usually longest thing there, and it push checks — part that change — below fold. Title link out for rest. Bot comments *are* rendered as markdown: Vercel comment carry table of deploy links, and flattened to text it wall of pipe characters. `stripBotMarkers` drop `[vc]: #<base64>` line and HTML comments first — both addressed to GitHub rather than to reader.

**Table cell wrap `anywhere`, and that fix belong to [Markdown](src/components/chat/Markdown.tsx) not to panel.** Streamdown table = `w-full` under `overflow-x-auto` wrapper, so cell that can't break set table's width: one file path in bot's "Files Changed" table pushed every other column off pane. `anywhere` not `break-word` — only `anywhere` shrink cell's *min-content* width, which what auto layout measure. Header cell need its `whitespace-nowrap` lifted first, or rule dead there. Cell also `align-top`. Wrapper keep own scroll for table genuinely wide.

## Repo view and diffs

**History open in place, and nothing open on arrival.** Not drill-in, not third column: column leave diff narrowest of three, drill-in hide history behind whichever commit open. Row expand under itself instead. Follow from that: **no default selection** — first commit touching thirty file would push rest of history off screen. Click open, click again close. **No chevron**: row = control, highlight say which open, second click prove it. Commit's *first file* selected on open, which is different question and safe, since file list already bounded by commit reader chose.

**Commit message live above diff, not in list.** History row hold subject alone, so commit whose reasoning in its body read as headline. Body drawn once, on diff's side: list = for *finding* commit, message = for reading one already found. Clamped to two line, or message push diff below fold; expanded it simply grow — scrollbox inside pane make reader ask twice for rest. "Show more" appear only when two line genuinely don't hold body — **measured** (`scrollHeight` vs `clientHeight`, `ResizeObserver`), since that depend on pane width. Measure only while collapsed: expanded element its own full height, report no overflow, and would retire button that collapse it back. Short sha ride subject's row — only fact about commit nowhere else in window. Card keyed on sha, so next commit arrive collapsed.

**Filename win the truncation.** One `truncate` span holding `dir + name` clip from *end*, which = filename — exact opposite of intent. So name draw first and `shrink-0`, directory after it and truncating. Right panel's rows keep old order for now.

**Toggle draw both option, not one glyph that swap.** Swapping glyph read as *picture of current state* — nothing about it say it can be pressed, and split/unified not convention reader arrive expecting.

**Channel between split halves = reserved scrollbar gutter, not gap.** Each column own horizontally-scrolling box carrying `scrollbar-gutter: stable`, so WebKit reserve classic scrollbar's width at its **inline end** — even though library zero that scrollbar (`::-webkit-scrollbar { width: 0 }`) and only ever *measure* horizontal one. Leave strip of dead background down right of each column, and make two look lopsided: left inset = library's own spacing, right = this. No variable expose it, so `unsafeCSS` (library's own escape hatch, inject into `@layer unsafe` = last in its layer order, so no `!important` needed) carry `[data-code] { scrollbar-gutter: auto; }`. Nothing lost: gutter only ever reserve room for scrollbar drawn at zero width. **Don't reach for `--diffs-gap-inline` here** — that inset "N unmodified lines" bar only, so tightening it shrink bar and leave channel.

**Library spacing dialled down from outside, through its shadow root.** `--diffs-gap-block` (8px padding above/below code) and `--diffs-gap-style` (2px rule between gutter and code, which in split view draw channel down middle wide enough to read as two halve drifting apart) both read *inside* shadow DOM with those name — and custom property cross that boundary, so setting them on any ancestor = whole override. `DIFF_SPACING` in [DiffPane](src/components/changes/DiffPane.tsx). Pane itself carry no padding either: its border = frame.

**History drill in, not third column.** Window can't hold commit list, file list *and* split diff without diff becoming narrowest of three. Selecting commit replace list with its files under back-header; selection kept on step back, so long history don't lose reader's place.

## Handoff row

**Composer = occluder, not a clip.** Buttons sit full height in reserve fraction as tall (`h-1` against their `h-7`), so most of each run past it and **behind card** — card opaque and paint later. Sliver deliberately tiny: enough to say something under there, not enough to read as row of buttons composer happen to be covering. Hover slide whole row clear (`-translate-y-7`). Clip instead leave same picture and different lie: button end where card start rather than continue behind it.

**Hover zone and thing it move = separate element, and have to be.** With one element, box travel with buttons — so cursor that opened row sit on its edge moment it open, row shut under it and reopen, forever. Zone stay put (`-top-7 pt-7`, turning 4px target into 32px one); only inner row translate, and it translate *within* zone, so cursor never outside it. `w-fit` keep that invisible box off rest of transcript's bottom edge, where full-width strip would swallow click and text selection.

**Row order interleave two ladder**: Commit, Create PR, Commit & push, Draft PR. Each ladder run plain-first then variant; reading across give two thing anyone do here, reading down give each one's longer form. Concatenated instead put both PR button at far end, where compound commit action sit between reader and thing they most often want next. `px-3` on reserve match card's own inner padding.

**Three fact, each a bug obvious version have:**

- Reserve = **fixed height**, row positioned out of flow inside it. In flow, row push composer down and transcript up every time cursor cross it on way to input.
- Buttons carry **opaque fill** — `secondary`, never `outline`. Outline = `bg-input/30` in dark palette, so transcript read straight through part meant to be hidden. No `default` variant either: primary fill near-white on this palette. Order carry priority instead.
- They take **no pointer events until row open**. Visible quarter sit directly above composer, so without this a click aimed at input and landing few px high send a commit.

**Composer card take own token, `--composer`, and that vibrancy fix not colour change.** Start as copy of `--card`, and whole of its job = be the one raised surface staying a **fill** on glass, since handoff row park behind it and veil there show buttons it exist to hide. Own token not borrowed `--popover`: composer not a popover. Exception live in vibrancy block beside rule it break — that where `--card` get its 5.5% and `--composer` deliberately don't.

Inline variant — same button along toolbar row, ghost and dimmed — built as mockup and **rejected**. Permanent-but-quiet still permanent: it spend width every turn on thing wanted at end of one.

Icons for `pr`/`draftPr` = same pair sidebar row and panel toggle draw, so mark and thing it lead to match everywhere.

Hover delay symmetric (150ms): keep cursor merely passing through from popping row open, and let one overshooting on way out come back without it having closed.

## Worktree notice and confirm dialog

**Two ways in, and shape follow who asked.** Settle raise **notice**, settled bar's button raise **dialog**. Settling, reader doing something else and being *offered* something, so safe answer must cost zero click: card expire into "keep it" after 15s and therefore carry no Keep button, since doing nothing already is keeping. Pressing "Delete worktree" = reader asking, and they owed confirm naming cost. Both read copy from [worktree.ts](src/lib/worktree.ts), so two route cannot drift into describing same deletion differently.

Notice = first `NoticeKind` raised by reader's own click rather than by something off screen, and first whose button **destroy** rather than navigate. Three thing follow.

**Action lead, subject ride beside it.** Card arrive unasked-for while reader doing something else, so first thing read = what it *want*, not what happened. `label` = `Delete worktree?`, `subject` = task's title muted **on same line**, `detail` = what survive and what don't. Leading with `Settled <task>` read as receipt, and receipt = thing you look away from; task on own third line made two heading-weight line read as two thing to deal with.

Task named by own **title** not by generated worktree name — `calm-navy-beacon` name directory reader never chose. Action `shrink-0` and title = half that give way; `title` attribute restore what clip took.

It only card with **two** button. Skip = answer card give itself when bar run out, so it there to be *said* rather than waited for — answer you can only give by waiting is one you cannot give.

**Tooltip holding only keycap need own left padding.** `TooltipContent` tighten `pr-1.5` when kbd present but leave `pl-3`, so tooltip that *only* cap sit visibly off-centre. Fixed in component not at call site: `has-[>[data-slot=kbd]:first-child]:pl-1.5` (and same for `kbd-group`).

**Accelerator in tooltip here, not in button.** Rest of stack draw keycap inline, which read fine on card holding one button and badly on this one holding two: row grow wider than sentence above it. So `WithShortcut` wrap each button in tooltip carrying cap. Empty `keys` render **no tooltip at all** rather than empty one: only top card answer to keys, and elsewhere tooltip would repeat button's own visible label back.

Dialog get **no** such confirmation: it close, and enough else on screen already say so.

Card also only one naming its subject, breaking `NoticeStack`'s own "verb and nothing else" rule on purpose — several card can stack, and "Settled" alone say nothing about which settle it answer for. Detail line say "its worktree", which reach directory through thing that own it. Title run to 60 char and card `w-fit`, so it capped and truncated with `title` attribute restoring rest. Dialog keep worktree name instead: it open from settled bar, where title already two inches away in header.

**Counts _are_ warning, so dialog one step not two.** Sidebar's delete and PR panel's merge take second confirm precisely because they carry no such detail; adding one here make reader confirm sentence they already read. Destructive fill only where something actually lost — on clean tree this tidying up, and red make safe answer look like dangerous one.

**Alert = `--popover`, not `--card`, and that vibrancy fix not taste.** Two token same colour with opaque page under them, so swap change nothing until glass on. There `--card` become 5.5% white veil — right for surface sitting *in* page, wrong for one floating over it. Notice card land on sidebar, which have no fill under vibrancy, so veil composite straight onto window material and leave text washed out. Applies to `Alert` in general, not just worktree one.

**Destructive confirm sit rightmost and take solid red.** `AlertDialogFooter` = `sm:flex-row sm:justify-end`, so source order = screen order — confirm must come **after** `AlertDialogCancel` in markup or it land on left. `destructive` prop on `AlertDialogAction` carry solid fill, not button's own `destructive` variant: that one a tint, for control sitting among others, where this the one thing in dialog that do something. Prop caller's to set — both dialog today destructive, but red default quietly colour first one that isn't.

## Settings dialog

**Dialog, not alert, and `showClose` = whole difference.** Frame, overlay and both animation copied from `alert-dialog` deliberately: to reader two are same object, differing only in whether app asking question or reader opened something. Alert answered by own buttons so carry no dismiss; dialog dismissed rather than answered, and Escape alone = way out only for people who already know it there. `--popover` not `--card` for [the vibrancy reason above](#worktree-notice-and-confirm-dialog).

**Gear in sidebar's titlebar strip, and it move in fullscreen.** Strip `justify-end` normally to clear traffic lights, `justify-start` in fullscreen where they gone. Sidebar toggle **also** drawn in app header when sidebar collapsed, so it must hold strip's outer edge in both layout and never change which end it at; gear have no second home, so gear = the one that move. Settings sit in that strip rather than filter row below, because every control in that row scope list under it and these app-wide.

**Row = label and reason left, control right** (`SettingRow`), **except where control wider than a switch — then it go under label, full width** (`stacked`). Beside-the-label take its width out of description, which then wrap to three ragged line and leave orphan, and dialog read as set of row that don't fit rather than list of setting. Under = also where picker want to be: option ranged along one edge, not pushed against far one. Description **not optional except where control show answer instead of telling it** — see theme row below; everywhere else it where "why is this off by default" live, and row with bare label make reader guess.

**Dialog wider than `Dialog`'s own default** (28rem against 25rem). Default sized for question and two button; this hold prose. Setting that cannot apply on this platform **disabled, not hidden**: row that vanish read as setting app forgot, and sentence under it = only place reason can be said.

**Switch one rung up from composer's own toggle** — `h-4 w-7` against its `h-3 w-5`. There track sit inside toolbar button among other 12px chrome; here it thing being pressed and have to take click on own.

**Copy say what it for and what it never touch, and stop.** Analytics row = two sentence, no itemised field list. Naming every field read as something to be wary of; "analytics" alone read as behavioural tracking. Second sentence — conversation and activity never collected — carry row.

**Group heading arrive with second group, not before.** One heading over only group there was = label for dialog, which `DialogTitle` already is. Separated by **space, not rules**, for reason PR panel's own sections are.

**Theme picked by looking at it, not by reading label.** Swatch draw theme's own backdrop — gradient and all — because each swatch carry `data-theme`/`data-mode` itself, so palette blocks match it exactly as they match `<html>`. Follow that swatch cannot drift from theme it stand for, which table of colours in TSX could and eventually would. Square, so it read as sample of colour rather than as picture of window.

**Name drawn beside swatch, never hovered for.** Colour say what theme *look* like, name say which one it is, and both wanted at once — hiding either behind tooltip make reader work for half answer. Name live **inside** button too, so accessible name = visible one rather than `aria-label` free to drift from it. Toggle of two word labels was first version and told reader nothing about what either look like; swatch alone was second and told them nothing about which was which.

**Theme row = only row with no description**, and rule it break is deliberate: control *is* explanation. Sentence saying "the palette everything uses" beside two visible palettes spend words on thing reader already seen. Switch keep its description, always — switch = word and a state, and sentence under it only place "why is this off by default" can live.

**Radio group = one Tab stop with arrows inside it.** `role="radiogroup"` without that = promise to screen reader that keyboard then break. Roving `tabIndex` other half, or tabbing through dialog walk palettes one at a time. Selection follow focus, right for group whose option cheap to try — here trying one *is* seeing it.

**Feedback block send people out, not into a form, and it deliberately not a `SettingRow`.** Nothing there a setting — no state to read back — so label a row demand ("Get in touch") sit under heading already saying Feedback and earn nothing but third line. Sentence plus two button = whole block. Most feedback = one sentence and form more than sentence worth, so button open DM; GitHub beside it for half who would rather send fix than describe it. Both go through `openUrl`, same route PR panel and transcript links take, so link land in reader's own browser rather than turning app window into one.

**`SettingRow` grew `asGroup`, and it about `htmlFor` reaching nothing.** Label only bind to labelable element, so theme's radio group have to be pointed other way — label carry id, group carry `aria-labelledby`. Switch rows unchanged.

## Update row

**Update row drawn only when there something to say.** Sidebar have no permanent footer; row reading "up to date" = chrome for fact nobody asked about. Show nothing while sidebar collapsed, deliberate — next check keep offer alive.

## Notice cards

Sidebar glow was third channel, cut. Landed in same corner as card, so it could not reach eye card wasn't already reaching, and invisible whenever sidebar collapsed. Animation shelved unimported in [attention-glow.css](src/styles/attention-glow.css) with own notes on how to rewire — worth several passes to get right, so next thing wanting pulse don't redo them.

**Card carry verb and nothing else** ([NoticeStack](src/components/NoticeStack.tsx)) — "Needs permission", "Task finished" — top-left, over sidebar it talk about and below traffic lights, where nothing else in app draw. No session title, no project, no icon: rail already mark row, so card repeating name spend its width saying what next glance say anyway. That leave one fact not on screen anywhere else, which is *what* is wanted. Desktop banner do opposite and have to: it land in stack beside every other app's notifications, so it name session and project or it say nothing. One `announce` build both from same label.

**Button = the control, and only one.** Earlier pass made whole card clickable with chevron for hint, not obvious enough to be trusted — card you not sure you can click = card you read and leave alone. Label name action rather than say "Open" twice: `View` for finished turn, `Answer` for waiting one, also fastest way to tell two otherwise identical cards apart. Take **primary** fill not secondary: card itself raised surface, and secondary button on top = one shade off thing it sit on — exactly "am I allowed to click this" chevron pass already failed. No dismiss button: card already leaving on own, so X to make it leave sooner = second target competing with one that matter.

## Images in the transcript, and the picker

**Tray stay inside card**, above text and on same edges. Outside it — way picker or toolbar sit — it fight `@` mention list for same strip of window, and two open at exactly same moment. Tile carry no size and no `title`: both describe file reader chose seconds ago.

**Sent image drawn outside bubble.** Bubble = container for speech; picture given fill and padding read as speech with frame drawn round it. They sit **above** text, matching composer's own tray. Thumbnails square and laid out as wrapping row not stack: two screenshots usually two views of one thing, and square keep row of mixed aspect ratios grid not ragged strip. They 80px against tray's 56px — transcript = where picture have to be recognized rather than merely counted, and still small because reader already know contents. Past **three** row stop counting and draw `+N` tile, which open viewer on first picture it standing in for.

**[ImageLightbox](src/components/chat/ImageLightbox.tsx) take whole set and index, not one image.** Bubble cap at 85% of column, so transcript can never show screenshot at readable size. It hold set because message carrying three screenshots = _one thing to look at_. Index = whole state, so opening at picture and stepping to next = same operation, and ← / → handled on `Dialog.Content` not window — dialog own focus while open, so keys scope themselves. Escape = Radix's own. **Click on backdrop close too, and Radix's outside-press cannot do it** — `Content` = `fixed inset-0`, so every click land inside it and `onPointerDownOutside` never fire. Test = `e.target === e.currentTarget`, which tell dark surround from things drawn on it. Two box carry it — padded frame, and column picture centred in. No `stopPropagation` anywhere. Both shortcuts stated on screen as `Kbd` caps rather than left to be guessed — dialog covering window owe reader its controls without hover to find them. Arrow caps sit **below** filmstrip as sentence — "Arrow keys ← → to switch" — since bare caps on strip's own row read as two more buttons.

Two details looking incidental. Image capped against own flex box not viewport, so filmstrip can never be pushed off bottom. And last index held in state across close, because Radix keep `Content` mounted while it fade and `index` already `null` by then — without it picture swap to first one on way out.

**Picture drawn without being opened**, unlike diff next to it. Row have nothing else — no text, no range, disabled expander.

**And drawn uncropped at reading size, where reader's own attachment stay 80px square.** `ImageRow` carry both as `variant`, and split turn on *who have seen picture already*. `sent` = receipt: reader picked it seconds ago. `returned` = opposite — screenshot agent took and read = one reader have **not** seen, and 80px crop of it say nothing. So `max-h-80 max-w-full`, both dimension left `auto` so cap scale picture rather than trim it: which part to throw away cannot be guessed. Border on it = only thing separating pale screenshot from page behind. Overflow past three go to line of text under row rather than `+N` tile, since tile have no size to match. Late-loading image shift layout and that already handled: `Chat`'s `ResizeObserver` re-pin bottom while following.

Component shared with `UserMessage` for `Avatar`'s reason: index meaning one picture in row and another in lightbox, and overflow control opening on first picture it stand for, = parts second copy drift on. `UserMessage` keep own "file is gone" row, since tool row already name path it read.

- **Picker have two modes, and mixing them what make list feel random.** With nothing typed it _browsing_: grouped, recents first under only heading in list, then harness commands, then everything installed — separated by gap not rules. Moment query exist it _searching_, and ranked list drawn flat: headers while filtering hide matches behind section chrome. `groupCommands` and `filterCommands` = two orderings and nothing blend them, so match quality always win search and habit only ever order browse.

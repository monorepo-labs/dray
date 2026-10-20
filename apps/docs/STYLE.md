# Writing the Dray docs

Pages live in `content/`, served at drayhq.com/docs. Blume builds the sidebar
from folders, and `llms.txt` / `llms-full.txt` from every page.

## Who reads this

People first. A person who just installed Dray, or one who wants to know if it
can do a thing. Second: an AI that was handed these docs and asked "can Dray do
X, and how?" Write for the person; the AI is served by the same page if it is
complete and concrete.

So every page answers three questions, in this order:

1. **What** it is and why you would use it. One short paragraph.
2. **Where** it lives. The exact place in the app: `Settings → Accounts`, the
   sidebar row's right-click menu, the composer's model picker, a shortcut.
3. **How** to do it. Steps when there are steps. Then what it doesn't do.

## Voice

- Second person, present tense. "You pick a model." Not "the user selects".
- Short sentences. Active voice. Plain words. Cut any word doing no work.
- Normal grammar. No marketing ("powerful", "seamless", "simply").
- Say what happens, not how it is built. No file names from the source, no
  Rust types, no wire formats, no event names. A path the reader will see or
  type (`~/.dray`, `~/.claude/skills`) is fine.

## Truth

- Every claim is checked against the code. Read the component, the command, the
  setting. Copy UI labels exactly as the app draws them.
- Document what shipped, never what is planned. A page promising a feature is a
  bug report waiting to happen.
- Not sure? Leave `{/* verify: what you could not confirm */}` and move on.
- Shortcuts: write the default (`⌘N`) and, once per page, that it can be changed
  in Settings → Shortcuts.

## Shape

- Frontmatter `title` and `description` on every page. The description is the
  page's summary in `llms.txt`, so make it say what the reader can do there:
  "Pick a model, effort and permission mode, and change them mid-session."
- Headings are tasks or nouns the reader would search for: "Fork a session",
  "Fast mode". Not "Overview".
- Limits go in a closing `## Limits` section, as a short list.
- Each fact lives on one page. Link to it from others rather than repeating it.
- Links are root-relative without `/docs`: `[Worktrees](/using-dray/worktrees)`.
- Where a screenshot would help, leave `{/* screenshot: what it shows */}`.

## Components

No imports needed. Use them sparingly.

- Callouts: `:::note`, `:::tip`, `:::warning` … `:::`
- `<Steps><Step title="…">…</Step></Steps>` for a sequence.
- Markdown tables for comparisons, flags and shortcut lists.
- Code blocks with a language: ```` ```bash ````.

## Map

| Folder | Covers |
|---|---|
| `get-started/` | Install, first session, updates and channels |
| `using-dray/` | Agents (one page for all five), composer, prompts, permissions, worktrees, sessions, spaces |
| `cli/` | The `dray` command line, every command and flag, orchestration |
| `settings/` | Accounts, issue trackers, dictation, appearance, notifications, shortcuts |
| `reference/` | Remote access and sharing, data on disk, privacy, troubleshooting |
| `server.mdx` | Connecting a Linux server over SSH (kept at its URL) |

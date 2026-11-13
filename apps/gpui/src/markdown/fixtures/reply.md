## What changed

The **wire** stays as it is, and the `dray-serve` binary ships *beside* the app. See [SERVE-PLAN.md](https://github.com/monorepo-labs/dray/blob/main/apps/desktop/SERVE-PLAN.md) for the frames, or ~~the old notes~~ nothing at all.

### Steps

1. Pin the toolkit
2. Port `buildTranscript` with its tests
   - streaming previews, with ***both*** kinds of __emphasis__ and _underscores_
   - abandoned tool calls in snake_case_names and 2*3*4 maths
3. Record a video — 20~25 seconds 🎬

- [ ] a task item
- [x] a finished one

| Surface | React | GPUI |
|---|:---:|---:|
| Sidebar | `Sidebar.tsx` | `sidebar.rs` |
| Transcript | `Chat.tsx` | **not yet** |
| A cell with a long path in it | `apps/desktop/src/components/chat/Markdown.tsx` | — |

```rust
fn frame_in(message: Message) -> Option<String> {
    // a * and a ** and a ` inside code stay as they are
    match message {
        Message::Text(text) => Some(text.to_string()),
        _ => None,
    }
}
```

> A quote, for the blockquote style, with `code` and a [link](https://drayhq.com).

Heading by underline
---

- > 25 is a comparison, not a quote
- the next is a rule

***

Inline `code`, *emphasis*, a bare link https://drayhq.com/docs and a ``double `tick` span``. A <kbd>tag</kbd> and a price of $5.

$$
x^2
$$

#### A fourth-level heading

Done. 你好，世界 — CJK and emoji 👍 both render.

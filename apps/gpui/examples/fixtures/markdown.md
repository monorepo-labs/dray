## Release checklist

The **wire** stays as it is, and the `dray-serve` binary ships beside the app. See [SERVE-PLAN.md](https://github.com/monorepo-labs/dray/blob/main/apps/desktop/SERVE-PLAN.md) for the frames.

1. Pin the toolkit
2. Port `buildTranscript` with its tests
   - streaming previews
   - abandoned tool calls
3. Record a video

| Surface | React | GPUI |
|---|---|---|
| Sidebar | `Sidebar.tsx` | `sidebar.rs` |
| Transcript | `Chat.tsx` | not yet |
| A cell with a long path in it | `apps/desktop/src/components/chat/Markdown.tsx` | — |

```rust
fn frame_in(message: Message) -> Option<String> {
    match message {
        Message::Text(text) => Some(text.to_string()),
        _ => None,
    }
}
```

> A quote, for the blockquote style.

![GitHub](https://avatars.githubusercontent.com/u/9919?s=80)

Inline `code`, *emphasis*, and a bare link: https://drayhq.com/docs

import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";

export type StreamingBlock = {
    index: number,
    type: "text" | "thinking" | "tool_use" | null
    /// Accumulated deltas. Prose for a text or thinking block; for a `tool_use`
    /// one it is the raw `input_json_delta` stream, which is a prefix of a JSON
    /// object rather than anything renderable — see [streamingCall](../lib/streaming.ts).
    text: string,
    /// Both set only on a `tool_use` block, from the `block_start` that opens it.
    /// The name is what the preview row renders before any argument has arrived;
    /// `callId` is the tool_use id, which the committed `tool_call_started`
    /// repeats as its `callId` and is matched on to retire this preview.
    name: string | null,
    callId: string | null,
}

/// sessionId → the one in-flight block (the CLI streams start→deltas→stop
/// serially).
///
/// A module store rather than state in `useSessions`, and that is the whole of
/// #305: held there, every delta re-rendered `App` and everything under it —
/// sidebar, crew, composer, every mounted transcript — at the rate the model
/// types. Here only the preview row reads the text, and `Chat` reads nothing
/// but which kind of block is open, which changes a few times a turn.
///
/// Two copies: `live` takes every delta, `shown` is what readers see. Growth is
/// published once per animation frame, since a delta nobody could have seen
/// painted is a render spent for nothing; opening and retiring a block are
/// published at once, because those change what the transcript draws around it.
let live: Record<string, StreamingBlock> = {};
let shown = live;
let frame = 0;
const changed = channel<void>();

function publish() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  shown = live;
  changed.emit();
}

/// A block opened. Replaces whatever the session had, as `block_start` does.
export function startStreamingBlock(sessionId: string, block: StreamingBlock) {
  live = { ...live, [sessionId]: block };
  publish();
}

/// Appends a delta to the session's open block, if it is the one the delta is
/// for. Painted on the next frame.
export function appendStreamingText(sessionId: string, index: number, text: string) {
  const cur = live[sessionId];
  if (!cur || cur.index !== index) return;
  // Deltas append; the type stays what block_start declared. Stamping "text"
  // here is what used to make streamed thinking render as assistant prose
  // until it committed.
  live = { ...live, [sessionId]: { ...cur, type: cur.type ?? "text", text: cur.text + text } };
  if (!frame) frame = requestAnimationFrame(publish);
}

/// The session's open block, read at call time rather than subscribed to.
export function peekStreamingBlock(sessionId: string): StreamingBlock | null {
  return live[sessionId] ?? null;
}

/// Drops the session's preview — only where `match` accepts it, when given.
export function retireStreamingBlock(
  sessionId: string,
  match?: (block: StreamingBlock) => boolean,
) {
  const cur = live[sessionId];
  if (!cur || (match && !match(cur))) return;
  const { [sessionId]: _, ...rest } = live;
  live = rest;
  publish();
}

/// The session's preview block, re-rendering at most once a frame while it
/// grows. For the row that draws it and nothing else.
export function useStreamingBlock(sessionId: string | null): StreamingBlock | null {
  return useSyncExternalStore(changed.subscribe, () =>
    sessionId ? (shown[sessionId] ?? null) : null,
  );
}

/// Which kind of preview the session is drawing, or null when none is — the
/// question the transcript around the preview asks. A string, so a delta that
/// only grows the text leaves it equal and re-renders nothing.
///
/// A text or thinking block counts only once it holds something, as the drawn
/// preview does: an empty one draws nothing and leaves the working indicator up.
export function useStreamingKind(
  sessionId: string | null,
): "text" | "thinking" | "tool" | null {
  return useSyncExternalStore(changed.subscribe, () => {
    const block = sessionId ? shown[sessionId] : undefined;
    if (!block) return null;
    if (block.type === "tool_use") return block.name ? "tool" : null;
    if (!block.text) return null;
    return block.type === "thinking" ? "thinking" : "text";
  });
}

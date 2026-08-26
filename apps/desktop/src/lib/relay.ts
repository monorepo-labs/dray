import type { MessageSender } from "@/types/events";

/// The line `attribute` in `orchestration.rs` puts in front of a relayed
/// prompt, rebuilt verbatim from the sender the event already names.
///
/// Rebuilt, never parsed. A regex over the text would have to guess where the
/// line ends, and a title holding a bracket or a reworded prefix would break it
/// *silently* — taking part of what was actually said with it. Building the
/// exact string from the same `MessageSender` the backend built it from can
/// only fail the safe way: no match, nothing stripped, the line stays drawn.
export function senderPrefix(from: MessageSender): string {
  return `[message from the Dray session "${from.title}" (${from.sessionId})]\n\n`;
}

/// The relayed text as the reader wants it — the sender's line taken off.
///
/// The prefix is for the receiving *agent*, which has no channel but the prompt
/// text. The reader has the `from` field drawn above the bubble instead, so the
/// same fact spelled out again in the first line is noise on their side.
export function stripSenderPrefix(text: string, from: MessageSender | null | undefined): string {
  if (!from) return text;

  const prefix = senderPrefix(from);
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

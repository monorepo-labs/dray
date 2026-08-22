import { SEGMENT_COLOR, highlightSegments, splitMention } from "@/lib/highlight";
import type { QueuedMessage } from "@/types/events";

/// Prompts typed into the running turn that the app is still holding.
///
/// They render below the transcript rather than inside it, alongside the
/// permission and question cards, for the same reason those do: none of them is
/// persisted, so none can be built from the event log. A queued prompt joins the
/// transcript proper the moment the backend hands it to the CLI, which arrives
/// as an ordinary `user_message` and retires the row drawn here.
///
/// Deliberately the same bubble `UserMessage` uses, dimmed rather than
/// restyled — it is the same message a moment early, and giving it its own
/// shape would read as a different kind of thing.
export default function QueuedMessages({ messages }: { messages: QueuedMessage[] }) {
  if (!messages.length) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {messages.map((message, i) => (
        <div key={message.id} className="flex w-full flex-col items-end gap-1">
          <div className="max-w-[85%] rounded-xl bg-card px-3 py-2 text-chat text-card-foreground opacity-55">
            <span className="whitespace-pre-wrap">
              {highlightSegments(message.text).map((segment, s) => {
                if (segment.kind === "mention") {
                  const { dir, name } = splitMention(segment.text);
                  return (
                    <span key={s} className={SEGMENT_COLOR.mention}>
                      <span className="opacity-45">{dir}</span>
                      {name}
                    </span>
                  );
                }
                return (
                  <span key={s} className={SEGMENT_COLOR[segment.kind]}>
                    {segment.text}
                  </span>
                );
              })}
            </span>
          </div>

          {/* Only under the newest, because Esc takes that one back and a hint
              on every row would promise each of them a key that reaches one. */}
          {i === messages.length - 1 && (
            <span className="pr-1 text-ui text-muted-foreground/60">Esc to cancel</span>
          )}
        </div>
      ))}
    </div>
  );
}

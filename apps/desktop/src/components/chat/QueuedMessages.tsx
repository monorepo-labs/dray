import ImageRow from "@/components/chat/ImageRow";
import { useAttachmentsByPath } from "@/hooks/useAttachments";
import { SEGMENT_COLOR, highlightSegments, splitMention } from "@/lib/highlight";
import { stripSenderPrefix } from "@/lib/relay";
import type { Attachment, ImageRef, QueuedMessage } from "@/types/events";

/// Prompts typed into the running turn that the app is still holding.
///
/// They render below the transcript rather than inside it, alongside the
/// permission and question cards, for the same reason those do: none of them is
/// persisted, so none can be built from the event log. A queued prompt joins the
/// transcript proper the moment the backend hands it to the CLI, which arrives
/// as an ordinary `user_message` and retires the row drawn here.
///
/// Deliberately the same bubble and the same image row `UserMessage` uses,
/// dimmed rather than restyled — it is the same message a moment early, and
/// giving it its own shape would read as a different kind of thing.
export default function QueuedMessages({ messages }: { messages: QueuedMessage[] }) {
  if (!messages.length) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {messages.map((message, i) => (
        // A component per row, because each has its own paths to resolve and a
        // hook cannot be called in a loop.
        <QueuedRow
          key={message.id}
          message={message}
          // Only under the newest, because Esc takes that one back and a hint
          // on every row would promise each of them a key that reaches one.
          hint={i === messages.length - 1}
        />
      ))}
    </div>
  );
}

function QueuedRow({ message, hint }: { message: QueuedMessage; hint: boolean }) {
  // Same strip the delivered bubble makes: a relayed prompt waits here carrying
  // the line written for the receiving agent, and it must not read one way
  // queued and another way sent.
  const body = stripSenderPrefix(message.text, message.from);
  const attachments = useAttachmentsByPath(message.attachmentPaths);

  return (
    <div className="flex w-full flex-col items-end gap-1">
      {/* Dimmed as one, so what was attached waits at the same strength as the
          sentence it was attached to. The hint is outside it: that is the app
          talking, not the message. */}
      <div className="flex w-full flex-col items-end gap-1.5 opacity-55">
        <ImageRow images={imagesOf(attachments)} variant="sent" align="end" />

        {/* Guarded like the delivered bubble's: a prompt can be an attachment
            and nothing else. */}
        {body && (
          <div className="max-w-[85%] rounded-xl bg-card px-3 py-2 text-chat text-card-foreground">
            {/* Same bubble, same break rule — see `UserMessage`. */}
            <span className="whitespace-pre-wrap wrap-anywhere">
              {highlightSegments(body).map((segment, s) => {
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
        )}
      </div>

      {hint && <span className="pr-1 text-ui text-muted-foreground/60">Esc to cancel</span>}
    </div>
  );
}

/// The pictures among the attachments, in the shape the delivered bubble's row
/// takes. A file draws nothing — see CLAUDE.md.
///
/// Through `url` and never `path`: the archived copy the asset protocol's scope
/// allows is written at flush, so these still name where the user picked them
/// from and `convertFileSrc` would resolve one to nothing.
function imagesOf(attachments: Attachment[]): ImageRef[] {
  return attachments.flatMap((attachment) =>
    attachment.isImage && attachment.preview
      ? [{ path: null, url: attachment.preview, mimeType: attachment.mimeType }]
      : [],
  );
}

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
/// Deliberately the same bubble `UserMessage` uses, dimmed rather than
/// restyled — it is the same message a moment early, and giving it its own
/// shape would read as a different kind of thing.
export default function QueuedMessages({ messages }: { messages: QueuedMessage[] }) {
  if (!messages.length) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {messages.map((message, i) => (
        // One component per row rather than a `map` in place: each has its own
        // paths to describe, and a hook cannot be called in a loop.
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
          sentence it was attached to. The hint below stays outside it: that is
          the app talking, not the message. */}
      <div className="flex w-full flex-col items-end gap-1.5 opacity-55">
        {/* The delivered bubble's own row, in its own place — above the text,
            growing from the same edge. Reused rather than restated so a picture
            cannot sit one way waiting and another way sent. */}
        <ImageRow images={imagesOf(attachments)} variant="sent" align="end" />

        {/* Guarded like the delivered bubble's, and now that it has to be: a
            prompt can be an attachment and nothing else, where an empty bubble
            under the picture is a grey box saying nothing. */}
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
/// takes.
///
/// Through `url` and never `path`: the asset protocol's scope is exactly
/// `~/.dray/attachments`, and these still point at wherever the user picked them
/// from — the copy under that directory is written at flush, so a path handed to
/// `convertFileSrc` here resolves to nothing. The preview the backend read for
/// the composer's tray stands in until then.
///
/// Anything that is not a picture draws nothing, deliberately. The delivered
/// bubble has no tile for one either: a file is handed to the model as an
/// `@path` mention appended to the prompt, which `attachments::prepare` writes
/// at flush and not before. A tile here would be swapped for a line of prose the
/// moment the message landed, which is the one thing this row exists not to do.
function imagesOf(attachments: Attachment[]): ImageRef[] {
  return attachments.flatMap((attachment) =>
    attachment.isImage && attachment.preview
      ? [{ path: null, url: attachment.preview, mimeType: attachment.mimeType }]
      : [],
  );
}

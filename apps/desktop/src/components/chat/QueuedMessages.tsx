import { CornerDownLeft } from "lucide-react";
import type { CSSProperties } from "react";

import ClampedBody from "@/components/chat/ClampedBody";
import ImageRow from "@/components/chat/ImageRow";
import { inlineMark } from "@/components/chat/InlineMark";
import { useHotkey } from "@/hooks/useHotkey";
import { useChord } from "@/hooks/useShortcuts";
import { imagesOf, type QueuedPrompt } from "@/hooks/useSessions";
import {
  SEGMENT_COLOR,
  highlightSegments,
  splitMention,
  withLineBreaks,
} from "@/lib/highlight";
import { commandBrand } from "@/lib/pluginBrand";
import { keyLabel, modifierLabels } from "@/lib/shortcuts";
import { stripSenderPrefix } from "@/lib/relay";

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
export default function QueuedMessages({
  messages,
  /// Stops the running turn so the flush that follows it happens now. Drawn
  /// only where waiting costs a whole turn, which is fx — see `Chat`.
  onSendNow,
}: {
  messages: QueuedPrompt[];
  onSendNow?: () => void;
}) {
  // Above the early return, since a hook cannot be conditional — and bound to
  // the prop rather than to fx by name, so the chord exists exactly where the
  // button does: on a harness that has one, with something held to send.
  useHotkey("queue.send", () => onSendNow?.(), { enabled: !!onSendNow && messages.length > 0 });
  // Read off the store the binding reads, so the hint cannot name a chord the
  // key no longer fires. Plain text rather than `ShortcutKeys`: a keycap is
  // chrome, and this line is one muted sentence under a dimmed bubble — two
  // filled chips in it are the loudest thing on screen after the message.
  //
  // Return is drawn as the composer's own glyph rather than as `⏎`, which is
  // what `keyLabel` answers: the hint under the empty composer says "Press ⏎ to
  // send" with this icon, so a character here would be a second spelling of one
  // key a few pixels away. The registry keeps the character for the Settings
  // tab, where a `Kbd` is a text chip.
  const chord = useChord("queue.send");

  if (!messages.length) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {messages.map(({ message, attachments }, i) => {
        // Same strip the delivered bubble makes: a relayed prompt waits here
        // carrying the line written for the receiving agent, and it must not
        // read one way queued and another way sent.
        const body = withLineBreaks(stripSenderPrefix(message.text, message.from));
        const brand = commandBrand(body);

        return (
          <div key={message.id} className="flex w-full flex-col items-end gap-1">
            {/* Dimmed as one, so what was attached waits at the same strength as
                the sentence it was attached to. The hint is outside it: that is
                the app talking, not the message. */}
            <div className="flex w-full flex-col items-end gap-1.5 opacity-55">
              <ImageRow images={imagesOf(attachments)} variant="sent" />

              {/* Guarded like the delivered bubble's: a prompt can be an
                  attachment and nothing else. */}
              {body && (
                <div
                  className="user-bubble max-w-[85%] rounded-xl bg-card px-3 py-2 text-chat text-card-foreground"
                  // Branded here too, or a Greptile command waits as an ordinary
                  // bubble and turns green the moment it is delivered — which is
                  // the "different kind of thing" this row exists not to be.
                  data-brand={brand ? "" : undefined}
                  style={brand ? ({ "--brand": brand } as CSSProperties) : undefined}
                >
                  {/* Same bubble, same break rule and the same twenty-line
                      clamp — see `ClampedBody` for why a held prompt cannot be
                      bounded differently to the delivered one. */}
                  <ClampedBody>
                    {highlightSegments(body).map((segment, s) => {
                      // Same marks the delivered bubble draws — see `inlineMark`
                      // for why a queued prompt cannot read differently.
                      const mark = inlineMark(segment, s);
                      if (mark) return mark;

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
                  </ClampedBody>
                </div>
              )}
            </div>

            {/* Only under the newest, because Esc takes that one back and a hint
                on every row would promise each of them a key that reaches one.
                Send now reaches the whole queue rather than this row, and sits
                here for the same reason: one line under the last of them. */}
            {i === messages.length - 1 && (
              <span className="flex items-center gap-1.5 pr-1 text-ui text-muted-foreground/60">
                {onSendNow && (
                  <>
                    <button
                      type="button"
                      onClick={onSendNow}
                      className="flex items-center gap-0.5 rounded-sm hover:text-foreground"
                    >
                      {/* One word and no glyph beside it. A send arrow was
                          tried and dropped: the line is one quiet sentence under
                          a dimmed bubble, and the arrow made it the loudest
                          thing on screen after the message itself. "Now" rather
                          than "Send" because it reads as the pair `Esc to
                          cancel` already is, and standing under a held prompt
                          there is nothing else it could send. Judged against a
                          four-character prompt, where the line is wider than the
                          bubble whatever it says — the accepted cost, since the
                          line answers for the whole queue rather than for the
                          one message above it. */}
                      Now
                      {/* Silent where the reader has unbound the chord: the
                          button still sends, and naming a key that no longer
                          fires is worse than naming none. */}
                      {chord && (
                        <span className="ml-0.5 flex items-center opacity-70">
                          {modifierLabels(chord).join("")}
                          {chord.key === "Enter" ? (
                            <CornerDownLeft className="size-3" strokeWidth={2} />
                          ) : (
                            keyLabel(chord)
                          )}
                        </span>
                      )}
                    </button>
                    <span aria-hidden>·</span>
                  </>
                )}
                <span>Esc to cancel</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

import AssistantMessage from "@/components/chat/AssistantMessage";
import { BotBubble } from "@/components/chat/BotTranscript";

/// A bot's chat before it has a session: its welcome, drawn as its first reply
/// in the column a transcript takes. The first send starts the session and
/// writes the same text into its log, so nothing moves when the real chat
/// replaces this one.
export default function BotWelcome({ text }: { text: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pt-6 pb-6">
        <BotBubble>
          <AssistantMessage text={text} />
        </BotBubble>
      </div>
    </div>
  );
}

import AssistantMessage from "@/components/chat/AssistantMessage";
import { BotBubble } from "@/components/chat/BotTranscript";

/// A bot's chat before it has a session: its greeting, drawn as its first
/// replies in the column a transcript takes. The first send starts the session
/// and writes the same messages into its log, so nothing moves when the real
/// chat replaces this one.
export default function BotWelcome({ messages }: { messages: string[] }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pt-6 pb-6">
        {messages.map((text, i) => (
          <BotBubble key={i}>
            <AssistantMessage text={text} />
          </BotBubble>
        ))}
      </div>
    </div>
  );
}

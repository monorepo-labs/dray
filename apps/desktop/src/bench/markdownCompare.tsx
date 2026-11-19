import { createRoot } from "react-dom/client";

import { StreamdownMarkdown } from "@/components/chat/Markdown";
import WordsMarkdown from "@/components/chat/WordsMarkdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatSessionContext } from "@/hooks/useChatSession";
import { REPLIES } from "@/bench/markdownCorpus";

/// The same real messages drawn by both renderers side by side, at the chat
/// column's width each, for screenshots. Click anywhere outside a message or
/// press Escape to close.
const SAMPLES = [
  REPLIES[0].text.split("\n").slice(0, 46).join("\n"),
  REPLIES[3].text.split("\n").slice(0, 110).join("\n"),
];

function Side({ title, words }: { title: string; words: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 px-6 py-6">
      <div className="font-mono text-xs text-muted-foreground">{title}</div>
      {SAMPLES.map((text, i) =>
        words ? (
          <WordsMarkdown key={i} linkFilePaths>
            {text}
          </WordsMarkdown>
        ) : (
          <StreamdownMarkdown key={i} linkFilePaths>
            {text}
          </StreamdownMarkdown>
        ),
      )}
    </div>
  );
}

export function showMarkdownCompare() {
  const el = document.createElement("div");
  el.className = "fixed inset-0 z-[2147483646] overflow-auto bg-background text-foreground";
  document.body.append(el);
  const root = createRoot(el);
  const close = () => {
    root.unmount();
    el.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  window.addEventListener("keydown", onKey);
  root.render(
    <ChatSessionContext value={{ cwd: "/home/user/project", sessionId: null }}>
      <TooltipProvider>
        <div className="flex divide-x divide-border">
          <Side title="Streamdown" words={false} />
          <Side title="Words" words />
        </div>
      </TooltipProvider>
    </ChatSessionContext>,
  );
}

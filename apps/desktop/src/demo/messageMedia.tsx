import React from "react";
import ReactDOM from "react-dom/client";

import AssistantMessage from "@/components/chat/AssistantMessage";
import { BotBubble } from "@/components/chat/BotTranscript";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import "../App.css";

/// Every picture and recording in one agent message opens one viewer: four
/// screenshots spread over paragraphs and a recording, in a task chat and a bot
/// chat, beside a message holding one picture, which opens alone. Click any
/// picture, or a recording's full-screen button, and arrow through the rest.

/// Every local path the page names is served from `demo/message-media/` by its
/// file name, so the real `fileSrc` route draws them with no seam in `src/`.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  convertFileSrc: (path: string) => `/demo/message-media/${path.split("/").pop()}`,
  invoke: async (called: string) => {
    if (called === "plugin:event|listen") return 0;
    throw new Error(`demo: nothing stubbed for ${called}`);
  },
};

const REPLY = `Here is the first screen.

![Image 1](/Users/you/shots/shot1.png)

The second one is a phone-sized screen.

![Image 2](/Users/you/shots/shot2.png)

Then two more, side by side:

![Image 3](/Users/you/shots/shot3.png)
![Image 4](/Users/you/shots/shot4.png)

And the recording:

/Users/you/.dray/browser/recordings/6a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d/clip.mp4

That is all of them.`;

const ALONE = `One screenshot, which opens on its own:

![Image 2](/Users/you/shots/shot2.png)`;

function Demo() {
  return (
    <main className="flex flex-col gap-6 pt-6 pr-6 pb-24 pl-56">
      <section className="flex flex-col gap-2">
        <p className="text-[13px] font-semibold">Task chat</p>
        <div className="flex w-[720px] flex-col gap-4 rounded-xl border border-border bg-background p-4 text-foreground">
          <AssistantMessage text={REPLY} />
          <AssistantMessage text={ALONE} />
        </div>
      </section>
      <section className="flex flex-col gap-2" data-bot-chat="">
        <p className="text-[13px] font-semibold">Bot chat</p>
        <div className="w-[720px] rounded-xl border border-border bg-background p-4 text-foreground">
          <BotBubble>
            <AssistantMessage text={REPLY} />
          </BotBubble>
        </div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
      <DemoThemeBar />
    </TooltipProvider>
  </React.StrictMode>,
);

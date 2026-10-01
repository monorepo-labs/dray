import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import QuestionRequest from "@/components/chat/QuestionRequest";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { questionDrafts } from "@/lib/questionDrafts";
import type { Question } from "@/types/events";
import "../App.css";

/// The question card surviving an unmount, which is what a session switch does
/// to it. Hide and show stand in for leaving the session and coming back.
const REQUEST = "demo-request";

const QUESTIONS: Question[] = [
  {
    question: "Which package manager should the scaffold use?",
    header: "Manager",
    multiSelect: false,
    freeText: true,
    options: [
      { label: "pnpm", description: "What this repo already uses.", preview: null },
      { label: "npm", description: null, preview: null },
      { label: "bun", description: null, preview: null },
    ],
  },
  {
    question: "Which checks should run on every PR?",
    header: "Checks",
    multiSelect: true,
    freeText: true,
    options: [
      { label: "Typecheck", description: null, preview: null },
      { label: "Unit tests", description: null, preview: null },
      { label: "Lint", description: null, preview: null },
    ],
  },
];

function Demo() {
  const [shown, setShown] = useState(true);
  const [answer, setAnswer] = useState<string | null>(null);

  return (
    <div className="flex min-h-screen flex-col gap-6 bg-background p-8 text-foreground">
      <DemoThemeBar />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setShown((s) => !s)}>
          {shown ? "Leave session" : "Come back"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            // What `permission_decided` does in the app.
            questionDrafts.delete(REQUEST);
            setAnswer(null);
            setShown(false);
            setTimeout(() => setShown(true));
          }}
        >
          Ask again
        </Button>
      </div>
      {shown && (
        <QuestionRequest
          requestId={REQUEST}
          questions={QUESTIONS}
          onAnswer={(answers) => setAnswer(JSON.stringify(answers))}
        />
      )}
      {answer && <pre className="text-xs">{answer}</pre>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
    </TooltipProvider>
  </React.StrictMode>,
);

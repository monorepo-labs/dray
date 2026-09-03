import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import QuestionRequest from "@/components/chat/QuestionRequest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Question } from "@/types/events";
import "./App.css";

/// The card the agent blocks on, with the harness faked out.
///
/// It exists to answer one thing — what the free-text box does as an answer runs
/// past a line — which cannot be looked at in the real app without an agent
/// asking something first. Delete the page once it has answered.
const CASES: { title: string; questions: Question[] }[] = [
  {
    title: "One question with a free-text box — what the growing box is for",
    questions: [
      {
        question: "Which package manager should the release script call?",
        header: "Package manager",
        multiSelect: false,
        freeText: true,
        options: [
          { label: "pnpm", description: "What the repo already uses.", preview: null },
          { label: "npm", description: null, preview: null },
        ],
      },
    ],
  },
  {
    title: "Free text and no options — pi's `input` dialog",
    questions: [
      {
        question: "Name the worktree.",
        header: null,
        multiSelect: false,
        freeText: true,
        options: [],
      },
    ],
  },
  {
    title: "Two questions: multi-select, then a closed list with previews",
    questions: [
      {
        question: "Which checks should run on push?",
        header: "Checks",
        multiSelect: true,
        freeText: true,
        options: [
          { label: "cargo test", description: "Rust tests.", preview: null },
          { label: "tsc", description: "Type check.", preview: null },
          { label: "vitest", description: null, preview: null },
        ],
      },
      {
        question: "Tabs or spaces?\nThe repo is inconsistent below apps/web.",
        header: "Indentation",
        multiSelect: false,
        freeText: false,
        options: [
          { label: "Spaces", description: "Two.", preview: "const a = {\n  b: 1,\n}" },
          { label: "Tabs", description: null, preview: "const a = {\n\tb: 1,\n}" },
        ],
      },
    ],
  },
];

function Demo() {
  // Remounting on a key is the point: the card is one-shot, so answering it once
  // leaves nothing to look at.
  const [round, setRound] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string> | null>(null);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background p-8 text-foreground">
        <div className="flex flex-col gap-10">
          {CASES.map((demo) => (
            <section key={demo.title} className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">{demo.title}</h2>
              <QuestionRequest
                key={`${demo.title}:${round}`}
                questions={demo.questions}
                onAnswer={setAnswers}
              />
            </section>
          ))}
        </div>

        {/* The answer map, since what the card sends is half of what it does. */}
        <pre className="mt-10 rounded-lg border border-border p-3 font-mono text-xs">
          {answers ? JSON.stringify(answers, null, 2) : "no answer sent yet"}
        </pre>

        <button
          className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm"
          onClick={() => {
            setAnswers(null);
            setRound((n) => n + 1);
          }}
        >
          Reset cards
        </button>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);

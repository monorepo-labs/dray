import { useEffect, useRef, useState } from "react";

import { X } from "lucide-react";
import type { Survey } from "posthog-js";

import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { dismiss, markShown, submit, type SurveyAnswers } from "@/lib/survey";
import { cn } from "@/lib/utils";

/// A survey PostHog wrote, drawn as Dray.
///
/// Sits where the notices sit and looks like them, because it is the same kind
/// of thing: the app asking for the reader rather than answering them. What it
/// is *not* is a notice — [`useNotices`] cards retire on a timer, and a
/// question that vanishes while somebody is deciding what to type is worse than
/// one never asked. This one goes when it is answered or when it is closed.
///
/// **Every answer is free text and the reader can see it.** The rule the rest
/// of the analytics keeps — nothing the reader writes ever leaves the machine —
/// is deliberately broken here and only here, and the card says so out loud: a
/// box somebody types into, under a line naming where it goes, is consent in
/// the plainest form there is. Nothing else about the session rides along.
export default function SurveyCard({
  survey,
  onClose,
}: {
  survey: Survey;
  onClose: () => void;
}) {
  const [answers, setAnswers] = useState<SurveyAnswers>(() =>
    survey.questions.map(() => ""),
  );
  const [sent, setSent] = useState(false);
  const first = useRef<HTMLTextAreaElement>(null);

  // Reported once, on the card actually reaching the screen, which is also what
  // stops it coming back — see `markShown`. Not at the point the survey is
  // *found*, since a survey fetched and never drawn was never asked.
  useEffect(() => {
    markShown(survey);
  }, [survey]);

  // Focus goes to the first box rather than the card: the reader is here to
  // type, and the close button taking focus would put Return on the wrong
  // control.
  useEffect(() => {
    first.current?.focus();
  }, []);

  /// Closing without answering. Reported, since "asked and ignored" and "never
  /// asked" are different numbers and only one of them says the question was
  /// wrong.
  const close = () => {
    if (!sent) dismiss(survey);
    onClose();
  };

  const answered = answers.some((answer) => answer.trim().length > 0);

  const send = () => {
    submit(survey, answers);
    setSent(true);
    // Left up long enough to be seen as an answer landing rather than the card
    // simply going. Nothing waits on the capture: it is fire-and-forget like
    // every other event here.
    window.setTimeout(onClose, 1200);
  };

  return (
    <div
      role="dialog"
      aria-label={survey.name}
      className="pointer-events-auto w-80 rounded-xl border border-border bg-popover p-3 shadow-lg"
    >
      {sent ? (
        <p className="py-2 text-center text-sm text-muted-foreground">Thank you.</p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">{survey.questions[0]?.question}</p>
            <Button
              variant="ghost"
              size="icon"
              className="-mt-1 -mr-1 size-6 shrink-0"
              onClick={close}
              aria-label="Close"
            >
              <X className="size-3.5" />
            </Button>
          </div>

          {survey.questions.map((question, index) => (
            <div key={question.id ?? index} className="mt-2">
              {index > 0 && (
                <p className="mb-1 text-sm font-medium">{question.question}</p>
              )}
              {question.description && (
                <p className="mb-1 text-xs text-muted-foreground">
                  {question.description}
                </p>
              )}
              <textarea
                ref={index === 0 ? first : undefined}
                value={answers[index]}
                onChange={(e) =>
                  setAnswers((prev) =>
                    prev.map((answer, at) => (at === index ? e.target.value : answer)),
                  )
                }
                rows={3}
                placeholder="Start typing…"
                className={cn(inputClassName, "h-auto resize-none py-1.5")}
              />
            </div>
          ))}

          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Sent to the Dray team.</p>
            <Button size="sm" onClick={send} disabled={!answered}>
              Submit
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

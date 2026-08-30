import { useEffect, useMemo, useRef, useState } from "react";

import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import type { Question } from "@/types/events";

/// The agent asking the reader something, rather than asking to run something.
///
/// Sits where the permission card sits and answers the same way — the harness is
/// blocked on it either way — but it carries no allow or deny. The call is never
/// in question; the filled-in form *is* the answer, and submitting an empty one
/// tells the agent it was ignored.
export default function QuestionRequest({
  questions,
  onAnswer,
}: {
  questions: Question[];
  /// Keyed by each question's verbatim text, because that is the key the
  /// harness matches on. A question the user skipped is absent rather than
  /// empty.
  onAnswer: (answers: Record<string, string>) => void;
}) {
  // One-shot, like the permission card: the reply can only be consumed once, so
  // a second submit during the round trip has nothing to answer.
  const [sent, setSent] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Nothing is required. Skipping is a real answer here — the harness honours a
  // partial set and only reports "did not answer" for an empty one — and
  // `Skip` renders at all only for an optional question.
  //
  // `choices` is what the shortcut numbers are assigned from, in this order, so
  // it has to be here and not only in the markup below.
  const items = useMemo(
    () =>
      questions.map((question) => ({
        name: question.question,
        required: false,
        choices: question.options.map((option) => ({ value: option.label })),
      })),
    [questions],
  );

  // The questionnaire listens on its own form rather than on the window, so
  // nothing is typeable until focus is inside it. Landing on the first choice
  // rather than the form arms every key at once: a number picks, arrows move,
  // and Enter confirms — that last one only fires when the event target is a
  // choice, so focusing the form itself would leave Enter dead.
  //
  // Taking focus is defensible here and nowhere else in the app: the agent is
  // blocked until this is answered, so it is the one thing on screen the reader
  // has to deal with. Once per mount — a re-render must not yank the caret back
  // out of the free-text box.
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLInputElement>("[data-slot=questionnaire-choice] input")
      ?.focus();
  }, []);

  return (
    // Narrower than the transcript it sits in. Options are a few words each, so
    // a full-width row leaves most of itself empty and puts the click target a
    // long way from the text naming it. No card chrome: the choices carry their
    // own borders, and a box around boxes reads as a third surface.
    <div className="max-w-md">
      <Questionnaire
        ref={formRef}
        className="gap-3"
        // Numbers rather than letters: an option's label is a word, so a letter
        // badge invites reading it as that word's initial when it isn't.
        shortcuts="numbers"
        items={items}
        onSubmit={(event) => {
          event.preventDefault();
          if (sent) return;
          setSent(true);
          onAnswer(collectAnswers(new FormData(event.currentTarget), questions));
        }}
      >
        {/* One question needs no "1 of 1". */}
        {questions.length > 1 && <QuestionnaireProgress />}

        {questions.map((question) => (
          <QuestionnaireItem
            // The harness guarantees question texts are unique within a call,
            // which is what lets the text serve as the form field name — and
            // keying the answer map by it needs no second mapping to drift.
            key={question.question}
            name={question.question}
            multiple={question.multiSelect}
            className="gap-2"
          >
            {/* `header` is deliberately unrendered. It is a chip-sized label the
                model writes alongside the question — "Indentation" over "Tabs or
                spaces?" — which reads as a heading for a section that isn't
                there, and says nothing the question doesn't. */}
            <QuestionnaireTitle className="text-chat font-medium">
              {question.question}
            </QuestionnaireTitle>

            <QuestionnaireChoices>
              {question.options.map((option) => (
                // The label is the value: the harness has no option ids, and
                // the answer it matches is the label string itself.
                // `min-h-0` drops the component's 44px touch target: this is a
                // desktop app, and an 11-unit floor on a one-word option is most
                // of the row's height doing nothing.
                <QuestionnaireChoice
                  key={option.label}
                  value={option.label}
                  className="min-h-0 py-2"
                >
                  <span className="font-medium">{option.label}</span>
                  {option.description && (
                    <QuestionnaireChoiceDescription>
                      {option.description}
                    </QuestionnaireChoiceDescription>
                  )}
                  {option.preview && (
                    <pre className="mt-1.5 overflow-x-auto rounded-md border border-border px-2.5 py-2 font-mono text-xs">
                      {option.preview}
                    </pre>
                  )}
                </QuestionnaireChoice>
              ))}

              {/* Offered wherever the asker can take an answer that isn't on
                  the list, which is every `AskUserQuestion`: the harness
                  promises the user a box and tells the model not to add an
                  "Other" option because of it, so dropping it there removes an
                  answer the question was written to allow.

                  pi's extension dialogs are the exception and the flag is
                  theirs. A `select` resolves to one of the extension's own
                  labels and a `confirm` to a boolean, so a typed sentence is
                  not an answer either can be given — the extension would be
                  handed a string it has no branch for. */}
              {question.freeText && (
                <QuestionnaireInput
                  aria-label="Another answer"
                  placeholder="Something else…"
                  className="min-h-0 h-8"
                />
              )}
            </QuestionnaireChoices>
          </QuestionnaireItem>
        ))}

        {/* A flex row rather than the component's three-column grid. Only ever
            two of these four are visible — Previous and Next hide for a single
            question, Next and Send are mutually exclusive — so the grid is a
            fixed set of tracks holding mostly hidden, `inert` cells, and its
            height comes from the tracks rather than from the buttons in it.
            A row is sized by what is actually in it, which is the property that
            matters here.

            `min-h-0` throughout drops the component's 44px touch targets: those
            are a mobile floor, and on a one-word option or a "Skip" they are
            most of the height doing nothing. */}
        <QuestionnaireActions className="flex min-h-0 items-center justify-end gap-2 sm:min-h-0">
          {/* Pushes the rest right; with it hidden `justify-end` already has. */}
          <QuestionnairePrevious size="sm" disabled={sent} className="mr-auto min-h-0" />
          <QuestionnaireSkip size="sm" disabled={sent} className="min-h-0" />
          <QuestionnaireNext size="sm" disabled={sent} className="min-h-0" />
          <QuestionnaireSubmit size="sm" disabled={sent} className="min-h-0">
            Send
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}

/// Reads the form back in the questions' own order.
///
/// `getAll` because a multi-select item puts one entry per checked box on the
/// form, while the harness wants a single comma-separated string — the same
/// shape its own dialog sends. A question with nothing checked and nothing typed
/// is left out entirely, which is what "skipped" means on the wire.
function collectAnswers(data: FormData, questions: Question[]): Record<string, string> {
  const answers: Record<string, string> = {};

  for (const question of questions) {
    const picked = data
      .getAll(question.question)
      .map(String)
      .filter((value) => value.trim().length > 0);

    if (picked.length > 0) answers[question.question] = picked.join(", ");
  }

  return answers;
}

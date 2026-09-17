// A survey PostHog writes and Dray draws.
//
// PostHog holds the questions, who sees them and when, and
// `getActiveMatchingSurveys` is the discovery call its own docs point custom
// integrations at. What it deliberately does not hold is the *look* — the stock
// popover is a white card with PostHog's byline, which in a glass dark window
// reads as pasted on. So the card is [SurveyCard](../components/SurveyCard.tsx)
// and everything below is the join between the two.
//
// **The survey is written as an ordinary popover over there**, not as the `api`
// type: that type exists on the wire but PostHog's UI need not offer it, and
// resting on one that might not be there would make the whole feature depend on
// a radio button. `disable_surveys_automatic_display` in
// [surveys.ts](./surveys.ts) is what makes that safe — the SDK fetches and
// never draws, whatever the survey calls itself.
//
// The one thing this costs over letting the SDK draw it: the response payload
// is ours to build, and a wrong key lands the answer somewhere the survey
// results view will not read it. Hence [`responseProperties`], which is pure
// and tested.
import posthog, {
  SurveyEventName,
  SurveyEventProperties,
  type Survey,
  type SurveyQuestion,
} from "posthog-js";

import { surveysStarted } from "@/lib/surveys";

/// What the reader typed, one per question, in the survey's own order. An
/// unanswered question is an empty string — which is what makes a skipped
/// optional question and an answered-then-cleared one the same thing, as they
/// should be.
export type SurveyAnswers = string[];

/// The property a question's answer travels under.
///
/// The first question keeps the bare `$survey_response`, which is the key the
/// results view has always read and the only one a single-question survey ever
/// uses. Later ones are keyed by the question's **id** where it has one and by
/// its index where it does not — `id` is optional on the wire, so an index is
/// the only thing always available, and the two cannot be told apart later.
export function responseKey(question: SurveyQuestion, index: number): string {
  if (index === 0) return SurveyEventProperties.SURVEY_RESPONSE;
  return `${SurveyEventProperties.SURVEY_RESPONSE}_${question.id ?? index}`;
}

/// The whole `survey sent` payload.
///
/// A first question carrying an id gets its answer under **both** keys, since
/// which one the results view reads has moved between PostHog versions and one
/// duplicated string is cheaper than an answer that arrives unreadable. Answers
/// past the survey's own question list are dropped rather than sent under a key
/// nothing will ask for.
export function responseProperties(
  survey: Survey,
  answers: SurveyAnswers,
): Record<string, string> {
  const properties: Record<string, string> = {
    [SurveyEventProperties.SURVEY_ID]: survey.id,
  };

  survey.questions.forEach((question, index) => {
    const answer = answers[index] ?? "";
    properties[responseKey(question, index)] = answer;
    if (index === 0 && question.id) {
      properties[`${SurveyEventProperties.SURVEY_RESPONSE}_${question.id}`] = answer;
    }
  });

  return properties;
}

/// The survey to draw, or `null` where there is none for this person.
///
/// Answers `null` rather than waiting where the SDK never started — an install
/// that opted out, or any build with no key compiled in, which is every local
/// one.
export async function activeSurvey(): Promise<Survey | null> {
  if (!(await surveysStarted())) return null;

  return new Promise((resolve) => {
    // Never rejects: a failed fetch is no survey, which is what the reader sees
    // anyway and is not worth a card of its own.
    try {
      posthog.getActiveMatchingSurveys((surveys) => resolve(surveys[0] ?? null));
    } catch (e) {
      console.error("[survey]", e);
      resolve(null);
    }
  });
}

/// Records that the reader was shown it, which is also what stops it coming
/// back: already-seen is one of the conditions `getActiveMatchingSurveys`
/// applies, so the mark is what makes "once per person" true rather than a
/// flag of our own free to disagree with PostHog's.
export function markShown(survey: Survey) {
  posthog.capture(SurveyEventName.SHOWN, { [SurveyEventProperties.SURVEY_ID]: survey.id });
  // On `surveys`, not the client — and the app takes the full bundle, where
  // that extension is guaranteed. The site's slim build is what makes the type
  // optional at all, and it is also what makes a survey undrawable there.
  posthog.surveys.markSurveyAsSeen(survey.id);
}

export function submit(survey: Survey, answers: SurveyAnswers) {
  posthog.capture(SurveyEventName.SENT, {
    ...responseProperties(survey, answers),
    [SurveyEventProperties.SURVEY_COMPLETED]: true,
  });
}

export function dismiss(survey: Survey) {
  posthog.capture(SurveyEventName.DISMISSED, {
    [SurveyEventProperties.SURVEY_ID]: survey.id,
  });
}

import { describe, expect, it, vi } from "vitest";

// The module reaches the SDK at import time for its event-name constants, and
// the app's own init module underneath that. Neither is exercised here — every
// rule under test is the payload's.
vi.mock("@/lib/surveys", () => ({ surveysStarted: () => Promise.resolve(false) }));

import type { Survey, SurveyQuestion } from "posthog-js";

import { responseKey, responseProperties } from "./survey";

const question = (text: string, id?: string) =>
  ({ type: "open", question: text, id }) as SurveyQuestion;

const survey = (...questions: SurveyQuestion[]) =>
  ({ id: "s1", name: "Feedback", questions }) as Survey;

describe("responseKey", () => {
  it("keeps the bare key for the first question", () => {
    expect(responseKey(question("missing?", "q1"), 0)).toBe("$survey_response");
  });

  it("keys later questions by id", () => {
    expect(responseKey(question("dislike?", "q2"), 1)).toBe("$survey_response_q2");
  });

  /// `id` is optional on the wire, so the index is the only thing always there.
  it("falls back to the index where a question carries no id", () => {
    expect(responseKey(question("dislike?"), 1)).toBe("$survey_response_1");
  });
});

describe("responseProperties", () => {
  it("names the survey and carries every answer", () => {
    const props = responseProperties(survey(question("missing?"), question("dislike?")), [
      "a picker",
      "the noise",
    ]);

    expect(props.$survey_id).toBe("s1");
    expect(props.$survey_response).toBe("a picker");
    expect(props.$survey_response_1).toBe("the noise");
  });

  /// Which key the results view reads for question one has moved between
  /// PostHog versions, and an answer under the wrong one arrives unreadable.
  it("sends the first answer under both keys where it has an id", () => {
    const props = responseProperties(survey(question("missing?", "q1")), ["a picker"]);

    expect(props.$survey_response).toBe("a picker");
    expect(props.$survey_response_q1).toBe("a picker");
  });

  /// A skipped question has to reach PostHog as an empty answer rather than as
  /// an absent key, or the results view reads a two-question survey as one.
  it("sends an unanswered question as empty", () => {
    const props = responseProperties(survey(question("missing?"), question("dislike?")), [
      "a picker",
    ]);

    expect(props.$survey_response_1).toBe("");
  });

  /// Answers past the survey's own questions are dropped — a key nothing asks
  /// for is a property nobody reads.
  it("ignores answers the survey has no question for", () => {
    const props = responseProperties(survey(question("missing?")), ["a picker", "stray"]);

    expect(Object.keys(props)).toEqual(["$survey_id", "$survey_response"]);
  });
});

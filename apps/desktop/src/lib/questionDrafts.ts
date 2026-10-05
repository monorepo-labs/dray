/// A question card's unsent answers, keyed by the request it answers.
///
/// Module-level for `useDraft`'s reason: the card unmounts when the reader
/// switches session, and the form was the only copy of what they had picked.
/// Request ids are minted per ask, so an entry is never read by another
/// question. `permission_decided` deletes the entry, since it lands for an
/// answer and a cancel alike.
export type QuestionDraft = {
  /// The question on screen, by its text.
  item?: string;
  /// Checked option labels per question.
  picked: Record<string, string[]>;
  /// The free-text box per question.
  text: Record<string, string>;
};

export const questionDrafts = new Map<string, QuestionDraft>();

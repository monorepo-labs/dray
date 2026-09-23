import { useCallback, useEffect, useRef, useState } from "react";

/// A copy button's confirmation: what went onto the clipboard, held for `ms`
/// and then dropped. `mark` is what `copied` holds meanwhile, the text itself
/// by default — so a control reused across sessions asks whether *its* text is
/// the copied one, and a stale flag cannot claim the next session's.
///
/// A failed write is logged and changes nothing: a button has nowhere to put an
/// error sentence, and no check mark is the honest answer.
export function useCopied<T = string>(ms = 1600) {
  const [copied, setCopied] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string, mark?: T): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error("failed to copy", err);
        return false;
      }
      setCopied(() => mark ?? (text as T));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), ms);
      return true;
    },
    [ms],
  );

  return [copied, copy] as const;
}

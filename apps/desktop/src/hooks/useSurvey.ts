import { useEffect, useState } from "react";

import type { Survey } from "posthog-js";

import { activeSurvey } from "@/lib/survey";

/// The survey to draw, looked for **once per launch** and never again.
///
/// Once is the whole of the trigger rule. There is no navigation in a
/// single-window desktop app to re-run a check off, and polling would put a
/// question in front of somebody mid-turn — which is the one moment they are
/// reading output rather than free to answer. So a survey created while the app
/// is open reaches the reader when they next open it, and the wait costs
/// nothing a survey is in a hurry about.
///
/// Who sees it is PostHog's answer, not this hook's: targeting, wait period and
/// already-seen are all conditions `getActiveMatchingSurveys` applies, and the
/// `session_count` a survey is aimed with rides the identity Rust hands over.
/// So the threshold — five sessions, today — is changed in PostHog rather than
/// here, which is the point of holding the question over there at all.
export function useSurvey(): { survey: Survey | null; close: () => void } {
  const [survey, setSurvey] = useState<Survey | null>(null);

  useEffect(() => {
    let live = true;
    void activeSurvey().then((found) => {
      if (live) setSurvey(found);
    });

    return () => {
      live = false;
    };
  }, []);

  return { survey, close: () => setSurvey(null) };
}

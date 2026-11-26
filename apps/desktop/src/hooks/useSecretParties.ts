import { createContext, useContext } from "react";

import type { Party } from "@/components/chat/PartyChip";

/// Who secret cards and lines name, which the transcript cannot know alone: a
/// bot's chat is the bot, a task is itself, and a task on another machine
/// reports to a bot whose chat lives elsewhere. `App` answers from the index
/// and the bot list; a demo answers with fakes.
export type SecretParties = {
  /// The bot `sessionId` reports to, at any depth, where there is one.
  botOf: (sessionId: string) => Party | null;
  /// Opens a party's chat, as a task row or a bot's line does.
  open: (party: Party, alone: boolean) => void;
};

export const SecretPartiesContext = createContext<SecretParties>({
  botOf: () => null,
  open: () => {},
});

export function useSecretParties(): SecretParties {
  return useContext(SecretPartiesContext);
}

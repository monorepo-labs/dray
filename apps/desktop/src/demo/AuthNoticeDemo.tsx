import { useState } from "react";

import ChatInput from "@/components/ChatInput";
import EventRow from "@/components/chat/EventRow";
import LoginExpiredNotice from "@/components/composer/LoginExpiredNotice";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authFailedTurn } from "@/lib/auth";
import type { AgentAvailability, AgentEvent, Harness } from "@/types/events";

/// What an auth failure looks like where the reader meets it: the harness's own
/// sentence closing the turn, and the cure sitting above the composer it just
/// blocked.
///
/// Scaffolding. Delete `demo.html` and this whole directory once it has been
/// looked at — it is a way of showing somebody a behaviour, not a fixture worth
/// keeping alive. Reachable only under `pnpm dev`: `vite.config.ts` names no
/// extra `rollupOptions.input`, so `pnpm build` emits `index.html` alone.
///
/// The components are the real ones with faked inputs, never second copies, so
/// a regression in any of them shows up here.
///
/// **Log in genuinely fails here, and that is worth seeing rather than working
/// around.** `invoke` rejects outside a webview, so the button takes its own
/// failure treatment — the alert glyph, the destructive tint, and the sentence
/// in a tooltip forced open. Copy command works, since the clipboard is the
/// browser's.

/// The harness facts the notice reads. Shaped exactly as `agent_availability`
/// answers, so nothing here can drift from what the app is handed.
const AGENTS: Record<Harness, AgentAvailability> = {
  claude_code: {
    harness: "claude_code",
    available: true,
    label: "Claude Code",
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    docsUrl: "https://code.claude.com/docs/en/quickstart",
    loginCommand: "claude auth login",
  },
  codex: {
    harness: "codex",
    available: true,
    label: "Codex",
    installCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    docsUrl: "https://learn.chatgpt.com/docs/codex/cli",
    loginCommand: "codex login",
  },
};

/// The sentence each harness really closes the turn with. Claude Code's is the
/// one read out of the 2.1.251 binary; Codex's rides its `Unauthorized`
/// discriminant, which reaches the row as the stop reason nothing draws.
const SENTENCES: Record<Harness, { text: string; stopReason: string | null }> = {
  claude_code: {
    text: "Failed to authenticate: OAuth session expired and could not be refreshed",
    stopReason: null,
  },
  codex: {
    text: "Your access token could not be refreshed. Please sign in again.",
    stopReason: "Unauthorized",
  },
};

function failedTurn(harness: Harness): AgentEvent {
  const { text, stopReason } = SENTENCES[harness];
  return {
    id: `turn-${harness}`,
    sessionId: "demo",
    harness,
    seq: 1,
    ts: new Date().toISOString(),
    turnId: null,
    subagent: null,
    raw: null,
    payload: {
      type: "turn_completed",
      status: "error",
      stopReason,
      authFailed: true,
      finalText: text,
      usage: null,
      durationMs: 820,
      head: null,
    },
  };
}

/// One harness end to end, read top to bottom the way the reader meets it.
function Case({ harness }: { harness: Harness }) {
  const event = failedTurn(harness);
  const [handled, setHandled] = useState<string | null>(null);

  // The app's own derivation, not a boolean flipped by hand — so the demo
  // exercises `authFailedTurn` rather than illustrating it.
  const authTurn = authFailedTurn([event]);
  const showNotice = authTurn !== null && authTurn !== handled;

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-ui font-medium text-foreground">{AGENTS[harness].label}</h2>
        {handled && (
          <button
            type="button"
            onClick={() => setHandled(null)}
            className="cursor-pointer text-ui text-muted-foreground underline"
          >
            Raise it again
          </button>
        )}
      </header>

      <div className="rounded-xl border border-border/60 bg-background/40 p-4">
        <div className="mx-auto max-w-3xl">
          <EventRow event={event} resultByCallId={new Map()} editsByCallId={new Map()} />
        </div>

        <div className="mt-6">
          <ChatInput
            onSend={async () => {}}
            sessionId={`demo-${harness}`}
            notice={
              showNotice && authTurn ? (
                <LoginExpiredNotice
                  agent={AGENTS[harness]}
                  cwd="/Users/you/code/dray"
                  onHandled={() => setHandled(authTurn)}
                />
              ) : null
            }
          />
        </div>
      </div>
    </section>
  );
}

export default function AuthNoticeDemo() {
  return (
    <TooltipProvider>
      <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-8 py-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium text-foreground">Auth failure, cause and cure</h1>
          <p className="text-ui text-muted-foreground">
            The failed turn draws the harness&rsquo;s own sentence, unchanged. The notice above the
            composer carries the cure and blocks sending until either button is pressed. Log in
            fails on this page — there is no webview behind it — which is what its failure state
            looks like.
          </p>
        </div>

        <Case harness="claude_code" />
        <Case harness="codex" />
      </main>
    </TooltipProvider>
  );
}

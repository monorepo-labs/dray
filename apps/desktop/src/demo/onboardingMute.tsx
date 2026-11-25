// Onboarding's mute button on the two pages it sits on: the Dray Bot step and
// the sign-in page. `?page=bot` mounts the real onboarding flow, with Tauri's
// IPC mocked so every agent and `gh` read as ready and the flow walks itself
// to the Dray Bot step in about 13s. `?page=signin` mounts the real sign-in
// page with the song started under it. The song plays for real wherever the
// browser lets a page start audio; the button shows either way.

import { mockIPC } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";

import SignInGate from "@/components/SignInGate";
import { Flow } from "@/components/onboarding/Onboarding";
import { startOnboardingMusic } from "@/components/onboarding/welcomeSounds";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { HARNESS_ORDER } from "@/lib/model";
import "../App.css";

const READY: Record<string, unknown> = {
  agent_accounts: HARNESS_ORDER.map((harness) => ({
    harness,
    label: harness,
    installed: true,
    accounts: [{ state: "logged_in" }],
    providers: [],
  })),
  recheck_gh: true,
  get_integrations: { linear: null, github: { name: "demo" } },
  list_bots: [],
};

mockIPC(
  (cmd, args) => {
    const inner = cmd === "server_invoke" ? String((args as { cmd: string }).cmd) : cmd;
    return READY[inner] ?? null;
  },
  { shouldMockEvents: true },
);

const page = new URLSearchParams(location.search).get("page") ?? "bot";
if (page === "signin") startOnboardingMusic(0, 0);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      {page === "signin" ? (
        <SignInGate
          view={{ kind: "choose", revoked: false, error: null, offline: false, emailOff: false, lastUsed: null }}
          onPick={() => {}}
          onOpenAgain={() => {}}
          onCancel={() => {}}
          onSkip={() => {}}
        />
      ) : (
        <Flow onStart={() => {}} />
      )}
      <DemoThemeBar />
    </TooltipProvider>
  </React.StrictMode>,
);

import { mockIPC } from "@tauri-apps/api/mocks";
import React, { useEffect, useRef, type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import EventRow from "@/components/chat/EventRow";
import PermissionRequest from "@/components/chat/PermissionRequest";
import SecretRequest, { SendSecurelyButton } from "@/components/chat/SecretRequest";
import SecretsSettings from "@/components/settings/SecretsSettings";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { SecretPartiesContext, type SecretParties } from "@/hooks/useSecretParties";
import type { AgentEvent, ServerInfo } from "@/types/events";
import { FingerPrintIcon, KeyIcon, LockClosedIcon, PaperAirplaneIcon, ShieldCheckIcon } from "@heroicons/react/16/solid";
import "../App.css";

const ICONS = [
  ["key", KeyIcon],
  ["lock-closed", LockClosedIcon],
  ["shield-check", ShieldCheckIcon],
  ["paper-airplane", PaperAirplaneIcon],
  ["finger-print", FingerPrintIcon],
] as const;

/// Every state of a secret card, the lines a closed one leaves, and Settings →
/// Secrets, through the real components. The server is faked in the page:
/// answering a card waits as the round trip would and changes nothing else.

const TASK = "01a21700-demo-task-log-gh-in";
const BOT_CHAT = "01a21700-demo-bot-chat";
const REMOTE_TASK = "01a21700-demo-remote-task";
const BOT = { id: "01a213f2-8a97-775f-b633-8793b2e29311", title: "Dray Bot", avatar: { shape: "round", hue: 210 } };

const parties: SecretParties = {
  asker: (sessionId) => (sessionId === BOT_CHAT ? BOT : { id: sessionId, title: "Log gh in on this box" }),
  botOf: () => BOT,
  open: (party) => console.info("open", party.title),
};

const SERVERS: ServerInfo[] = [
  { id: "remotebox", name: "remotebox", status: "connected" } as ServerInfo,
];
const SAVED: Record<string, { name: string; modified: string; always?: boolean }[]> = {
  local: [
    { name: "GITHUB_TOKEN", modified: "2026-11-20T09:12:00Z", always: true },
    { name: "NPM_TOKEN", modified: "2026-11-02T16:40:00Z" },
    { name: "OPENAI_API_KEY", modified: "2026-10-28T11:05:00Z" },
  ],
  remotebox: [{ name: "CLOUDFLARE_API_TOKEN", modified: "2026-11-24T18:30:00Z" }],
};

mockIPC(async (cmd, args) => {
  const call =
    cmd === "server_invoke"
      ? (args as { server: string; cmd: string; args: Record<string, unknown> })
      : { server: "local", cmd, args: args as Record<string, unknown> };
  switch (call.cmd) {
    case "list_servers":
      return SERVERS;
    case "local_server":
      return null;
    case "list_secrets":
      return SAVED[call.server] ?? [];
    case "answer_secret_request":
    case "save_secret":
    case "delete_secret":
    case "set_secret_always":
      await new Promise((r) => setTimeout(r, 600));
      return null;
    default:
      return null;
  }
});

let seq = 0;
const event = (sessionId: string, payload: unknown): AgentEvent =>
  ({
    id: `e${seq}`,
    sessionId,
    harness: "claude_code",
    seq: seq++,
    ts: new Date().toISOString(),
    turnId: null,
    subagent: null,
    payload,
  }) as AgentEvent;

const remote = { sessionId: REMOTE_TASK, title: "Deploy the worker", machine: "remotebox", machineId: "remotebox", requestId: "r1" };
const answered = (sessionId: string, outcome: string, extra: Record<string, unknown> = {}) =>
  event(sessionId, { type: "secret_answered", requestId: `a${seq}`, name: "GITHUB_TOKEN", outcome, ...extra });

const ROWS: { label: string; event: AgentEvent }[] = [
  { label: "Pasted", event: answered(TASK, "saved") },
  { label: "Declined", event: answered(TASK, "declined") },
  { label: "Used a saved one", event: answered(TASK, "used", { kept: true }) },
  { label: "Used without asking", event: answered(TASK, "used", { kept: true, always: true, auto: true }) },
  { label: "Bot's chat: sent to a task elsewhere", event: answered(BOT_CHAT, "used", { kept: true, task: remote }) },
  { label: "Bot's chat: declined for a task", event: answered(BOT_CHAT, "declined", { task: remote }) },
  {
    label: "The task's own chat, on its machine",
    event: event(REMOTE_TASK, { type: "secret_requested", requestId: "r1", name: "GITHUB_TOKEN", reason: "Sign gh in", bot: true }),
  },
];

/// A card already switched to its paste field, as clicking Paste a new one leaves it.
function Pasting({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const button = [...(ref.current?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Paste a new one");
    button?.click();
  }, []);
  return <div ref={ref}>{children}</div>;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 px-6">
      <div className="border-t border-border pt-4">
        <h2 className="text-ui font-medium">{title}</h2>
        {note && <p className="text-ui text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Demo() {
  const base = { requestId: "q", url: "https://github.com/settings/tokens" };
  return (
    <TooltipProvider>
      <SecretPartiesContext value={parties}>
        <div className="mx-auto flex max-w-3xl flex-col gap-8 px-0 py-10 pb-28">
          <div className="flex flex-col gap-1 px-6">
            <h1 className="text-lg font-medium">Secrets</h1>
            <p className="text-ui text-muted-foreground">
              The real card, lines and Settings page. Answering waits as the server would and changes nothing else.
            </p>
          </div>

          <Section title="Send securely, solid icons" note="Heroicons 16 solid on the real button. Key is what the card uses now.">
            <div className="flex flex-wrap gap-6">
              {ICONS.map(([label, Icon]) => (
                <div key={label} className="flex flex-col items-start gap-2">
                  <SendSecurelyButton type="button" icon={Icon} />
                  <span className="text-ui text-muted-foreground">{label}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Beside a permission card" note="The real PermissionRequest first, then a first ask, as they would stack in a chat.">
            <div className="flex flex-col gap-4">
              <PermissionRequest
                description="Install wrangler in apps/upload-worker"
                argument="pnpm add -D wrangler"
                options={[
                  { id: "once", label: "Allow once", kind: "once", behavior: "allow" },
                  { id: "rule", label: "Always allow pnpm add", kind: "always_rule", behavior: "allow" },
                  { id: "deny", label: "Deny", kind: "deny", behavior: "deny" },
                ]}
                onRespond={() => {}}
              />
              <SecretRequest sessionId={TASK} {...base} name="CLOUDFLARE_API_TOKEN" reason="Deploy with wrangler" url="https://dash.cloudflare.com/profile/api-tokens" autoFocus={false} />
            </div>
          </Section>

          <Section title="First ask" note="Nothing saved on the machine.">
            <SecretRequest sessionId={TASK} {...base} name="GITHUB_TOKEN" reason="Sign gh in" autoFocus={false} />
          </Section>

          <Section title="Saved" note="GITHUB_TOKEN is saved, so one click; the arrow picks another saved one.">
            <SecretRequest
              sessionId={TASK}
              {...base}
              name="GITHUB_TOKEN"
              reason="Sign gh in"
              savedNames={["GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY"]}
              closest="GITHUB_TOKEN"
              autoFocus={false}
            />
          </Section>

          <Section title="Paste a new one" note="After Paste a new one: the field, and Use saved to go back.">
            <Pasting>
              <SecretRequest
                sessionId={TASK}
                {...base}
                name="GITHUB_TOKEN"
                reason="Sign gh in"
                savedNames={["GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY"]}
                closest="GITHUB_TOKEN"
                autoFocus={false}
              />
            </Pasting>
          </Section>

          <Section title="Name mismatch" note="The agent asked for GH_TOKEN; GITHUB_TOKEN is the nearest saved. The agent gets it as GH_TOKEN.">
            <SecretRequest
              sessionId={TASK}
              {...base}
              name="GH_TOKEN"
              reason="Sign gh in"
              savedNames={["GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY"]}
              closest="GITHUB_TOKEN"
              autoFocus={false}
            />
          </Section>

          <Section title="Bot's card for a task on another machine" note="In the bot's chat; the value goes to remotebox.">
            <SecretRequest
              sessionId={BOT_CHAT}
              requestId="q"
              name="CLOUDFLARE_API_TOKEN"
              reason="Deploy with wrangler"
              url="https://dash.cloudflare.com/profile/api-tokens"
              task={remote}
              autoFocus={false}
            />
          </Section>

          <Section title="Lines a closed card leaves" note="Same size as Started a new task; chips open their chat.">
            <div className="flex flex-col gap-4">
              {ROWS.map((r) => (
                <div key={r.event.id} className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-wide text-muted-foreground/70 uppercase">{r.label}</span>
                  <EventRow event={r.event} resultByCallId={new Map()} />
                </div>
              ))}
            </div>
          </Section>

          <Section title="Settings → Secrets" note="The machine picker at the top; Auto is the switch; ⋯ holds Replace and Delete.">
            <div className="max-w-xl rounded-xl border border-border p-6">
              <SecretsSettings />
            </div>
          </Section>
        </div>
        <DemoThemeBar />
      </SecretPartiesContext>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);

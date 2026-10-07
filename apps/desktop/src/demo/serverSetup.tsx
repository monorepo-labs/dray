// Setting a server up, end to end, with no server: the real Settings page, the
// real Add server dialog, the real install dialog and the real Accounts tab,
// over a scripted fake of the Tauri commands they call. Every state is a
// button in the bar across the top; a state past the first screen is reached
// by the bar clicking through the real UI, the way a reader would.
//
// For the whole app against real `dray-serve`s instead, see /demo/servers.html.

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import React, { useState, useSyncExternalStore } from "react";
import ReactDOM from "react-dom/client";

import SettingsPage from "@/components/SettingsPage";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { useIntegrations } from "@/hooks/useIntegrations";
import { cn } from "@/lib/utils";
import type {
  Account,
  AgentAccounts,
  AgentAvailability,
  AuthOption,
  Failure,
  Harness,
  ServerInfo,
  Stage,
  Survey,
} from "@/types/events";
import "../App.css";

// ── the fake backend ──────────────────────────────────────────────────────────

/// One step of anything slow: a login, a stage, a survey. Long enough to read
/// the spinner and the stage word, short enough to walk every state.
const STEP = 900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Bumped per scenario. Fake work started under an older one stops, or its
/// events land in the next scenario's dialog and it eats that one's failure.
let epoch = 0;
const stale = (mine: number) => {
  if (mine !== epoch) throw new Error("demo: superseded");
};

/// "Fail the next step": the next slow command fails the way its real one
/// most often does, then the box unticks itself.
let failNext = false;
const failListeners = new Set<() => void>();
function setFailNext(on: boolean) {
  failNext = on;
  for (const l of failListeners) l();
}
function takeFail(): boolean {
  if (!failNext) return false;
  setFailNext(false);
  return true;
}

const LINE = "ssh root@203.0.113.7";
const dest = (line: string) => line.trim().split(/\s+/).pop()!;
const hostOf = (line: string) => dest(line).replace(/^.*@/, "");

/// `ssh.rs`'s own sentences, so a reworded one there is a stale one here.
const FAIL = {
  unknownHost: (host: string): Failure => ({
    message: `This Mac has never connected to ${host}.`,
    fix: { kind: "trust_host", host, keyType: "ED25519", fingerprint: "SHA256:Jq3kYw7c2X0d9p5mO1nqVf8vR4bL6tZ0yHs2eWuA9gk" },
  }),
  changedKey: (host: string): Failure => ({
    message: `${host} is answering with a different host key than last time. That can mean someone is in the middle. If you know why it changed, remove the old key and try again:`,
    fix: { kind: "copy", command: `ssh-keygen -R ${host}` },
  }),
  password: (host: string, line: string): Failure => ({
    message: `${host} wants a password. Set up a key first, then try again:`,
    fix: { kind: "copy", command: `ssh-copy-id ${dest(line)}` },
  }),
  unreachable: (host: string): Failure => ({
    message: `Could not reach ${host}: ssh: connect to host ${host} port 22: Operation timed out`,
    fix: null,
  }),
  missing: (host: string): Failure => ({ message: `Dray isn't installed on ${host}.`, fix: { kind: "install" } }),
  neverRun: (host: string): Failure => ({
    message: `Dray is on ${host} but its server has never run there.`,
    fix: { kind: "copy", command: "dray service start" },
  }),
};

/// What each SSH line answers: how its login goes, and what state Dray is in there.
type Host = {
  login: keyof typeof FAIL | null;
  dray: "running" | "stopped" | "missing" | "never";
  survey: Survey;
  /// Picks that `dray setup` warns about and carries on past.
  stubborn: string[];
};

const tools = (found: string[]) =>
  [
    ["git", "git"],
    ["gh", "GitHub CLI"],
    ["claude_code", "Claude Code"],
    ["codex", "Codex"],
    ["pi", "pi"],
    ["fx", "fx"],
    ["grok", "Grok Build"],
  ].map(([id, name]) => ({ id, name, found: found.includes(id) }));

const freshHost = (over: Partial<Host> = {}): Host => ({
  login: null,
  dray: "running",
  survey: { os: "Linux", tools: tools(["git", "codex"]), gitCommand: null },
  stubborn: [],
  ...over,
});

let hosts = new Map<string, Host>();
const host = (line: string) => hosts.get(line) ?? hosts.set(line, freshHost()).get(line)!;
/// The pause between install lines; one scenario turns it right down.
let lineDelay = 260;

let servers: ServerInfo[] = [];
const announce = () => void emit("servers_changed", servers);
function patch(id: string, next: Partial<ServerInfo>) {
  servers = servers.map((s) => (s.id === id ? { ...s, ...next } : s));
  announce();
}

const serverInfo = (over: Partial<ServerInfo> & Pick<ServerInfo, "id" | "name">): ServerInfo => ({
  named: true,
  url: "",
  ssh: null,
  on: true,
  status: "connected",
  stage: null,
  error: null,
  fix: null,
  ...over,
});

/// A connect over SSH, as `ssh::open` walks it: log in, find the server,
/// start it if it is stopped. Answers why it stopped, or nothing.
async function dial(line: string, report: (stage: Stage) => void): Promise<Failure | null> {
  const h = host(line);
  const name = hostOf(line);
  const mine = epoch;
  report("connecting");
  await sleep(STEP);
  stale(mine);
  if (takeFail()) return FAIL.unreachable(name);
  if (h.login) return FAIL[h.login](name, line);
  report("finding");
  await sleep(STEP);
  stale(mine);
  if (h.dray === "missing") return FAIL.missing(name);
  if (h.dray === "never") return FAIL.neverRun(name);
  if (h.dray === "stopped") {
    report("starting");
    await sleep(STEP);
    h.dray = "running";
  }
  return null;
}

/// `dray setup --install` as the dialog sees it: one line at a time, ANSI gone.
function installScript(line: string, picks: string[]): string[] {
  const h = host(line);
  const name = (id: string) => h.survey.tools.find((t) => t.id === id)?.name ?? id;
  const found = h.survey.tools.filter((t) => t.found).map((t) => t.name);
  const out = [
    "Downloading dray 0.9.0 for linux-x86_64…",
    "Installed dray to /root/.local/bin/dray",
    "┌  Dray setup",
  ];
  if (found.length) out.push("│", `◇  Found ${found.join(", ")}`);
  for (const id of picks) {
    out.push("│", `●  Installing ${name(id)}`);
    if (id === "git") out.push("Reading package lists...", "Building dependency tree...", "Setting up git (1:2.43.0-1ubuntu7.2) ...");
    else if (id === "gh") out.push("Get:1 https://cli.github.com/packages stable/main amd64 gh amd64 2.62.0 [12.4 MB]");
    else out.push(`Downloading ${name(id)}…`, `${name(id)} installed to /root/.local/bin`);
    out.push("│", h.stubborn.includes(id) ? `▲  ${name(id)} did not install: exit status 100` : `◇  ${name(id)} installed`);
  }
  return [
    ...out,
    "│",
    "◇  Server running in the background",
    "│  The server is running in the background.",
    "└  In the Dray app, Add server and paste:",
    "",
    `   ${line}`,
  ];
}

// Accounts, per server: the local set reads like a well-used Mac; a fresh
// server holds two CLIs and no logins.
const account = (label: string, state: Account["state"], authType: string | null = null, detail: string | null = null, provider: string | null = null): Account => ({
  provider,
  label,
  state,
  detail,
  authType,
  canSignOut: state === "logged_in",
  canChangeMethod: true,
});
const agent = (harness: Harness, label: string, accounts: Account[] | null): AgentAccounts => ({
  harness,
  label,
  installed: accounts !== null,
  accounts: accounts ?? [],
  providers: [],
  providerFreeform: harness === "pi",
  loginHint: null,
  error: null,
});

const localAccounts = (): AgentAccounts[] => [
  agent("claude_code", "Claude Code", [account("Anthropic", "logged_in", "Claude subscription", "you@example.com · max")]),
  agent("codex", "Codex", [account("OpenAI", "logged_in", "ChatGPT subscription", "you@example.com")]),
  agent("pi", "pi", []),
  agent("fx", "fx", [
    account("Vercel AI Gateway", "logged_in", null, "you@example.com", "vercel"),
    account("Codex", "logged_out", null, null, "codex"),
    account("Grok", "logged_out", null, null, "grok"),
  ]),
  agent("grok", "Grok Build", null),
];
const remoteAccounts = (): AgentAccounts[] => [
  agent("claude_code", "Claude Code", [account("Anthropic", "logged_out")]),
  agent("codex", "Codex", [account("OpenAI", "logged_out")]),
  agent("pi", "pi", null),
  agent("fx", "fx", null),
  agent("grok", "Grok Build", null),
];
let accounts = new Map<string, AgentAccounts[]>();
const accountsOn = (server: string) =>
  accounts.get(server) ?? accounts.set(server, server === "local" ? localAccounts() : remoteAccounts()).get(server)!;
function signIn(server: string, harness: string, provider: string | null, auth: string, on: boolean) {
  const AUTH: Record<string, string> = { claudeai: "Claude subscription", console: "Anthropic Console", chatgpt: "ChatGPT subscription", api_key: "API key" };
  accounts.set(
    server,
    accountsOn(server).map((a) =>
      a.harness !== harness
        ? a
        : {
            ...a,
            accounts: a.accounts.map((acc) =>
              acc.provider !== provider
                ? acc
                : on
                  ? { ...acc, state: "logged_in", authType: AUTH[auth] ?? null, detail: "you@example.com", canSignOut: true }
                  : { ...acc, state: "logged_out", authType: null, detail: null, canSignOut: false },
            ),
          },
    ),
  );
}

const AUTH_OPTIONS: Partial<Record<Harness, AuthOption[]>> = {
  claude_code: [
    { id: "claudeai", label: "Claude subscription", needsKey: false, command: "claude auth login", hint: null },
    { id: "console", label: "Anthropic Console", needsKey: false, command: "claude auth login --console", hint: "Billed per token against your Console account." },
  ],
  codex: [
    { id: "chatgpt", label: "ChatGPT subscription", needsKey: false, command: "codex login", hint: null },
    { id: "api_key", label: "OpenAI API key", needsKey: true, command: null, hint: "Billed per token. Replaces the ChatGPT sign-in until you sign in again." },
  ],
};

/// The commands one server answers, local or remote alike.
async function core(cmd: string, a: Record<string, unknown>, server: string): Promise<unknown> {
  switch (cmd) {
    case "agent_accounts":
      await sleep(STEP / 2);
      return accountsOn(server);
    case "agent_availability":
      return accountsOn(server).map(
        (acc): AgentAvailability => ({
          harness: acc.harness,
          available: acc.installed,
          label: acc.label,
          reason: acc.installed ? "" : `${acc.label} isn't installed, so this session can't start.`,
          installCommand: acc.installed ? null : `curl -fsSL https://example.com/${acc.harness}/install.sh | sh`,
          docsUrl: acc.installed ? null : "https://example.com/docs",
          loginCommand: "",
          loginHint: null,
        }),
      );
    case "agent_auth_options":
      return AUTH_OPTIONS[a.harness as Harness] ?? [];
    case "add_agent_account":
      await sleep(STEP);
      if (takeFail()) throw "That key was refused.";
      signIn(server, String(a.harness), (a.provider as string) ?? null, String(a.auth), true);
      return null;
    case "sign_out_agent":
      await sleep(STEP / 2);
      signIn(server, String(a.harness), (a.provider as string) ?? null, "", false);
      return null;
    case "run_agent_login":
      // A Terminal opens; Refresh is how the page learns. Signed in by then.
      signIn(server, String(a.harness), (a.provider as string) ?? null, String(a.auth), true);
      return null;
    default:
      throw new Error(`demo: nothing stubbed for ${cmd}`);
  }
}

mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "list_servers":
        return servers;
      case "add_server": {
        await sleep(STEP);
        const url = String(a.url).replace(/^(?!ws:\/\/)/, "ws://");
        if (takeFail()) throw `the server refused: bad token`;
        const name = (a.name as string) || new URL(url).hostname;
        const info = serverInfo({ id: crypto.randomUUID().slice(0, 8), name, named: !!a.name, url });
        servers = [...servers, info];
        announce();
        return info;
      }
      case "add_ssh_server": {
        const line = String(a.line).trim();
        const failed = await dial(line, (stage) => void emit("server_adding", stage));
        if (failed) throw failed;
        const existing = servers.find((s) => s.ssh === line);
        const name = (a.name as string) || hostOf(line);
        if (existing) {
          patch(existing.id, { name, on: true, status: "connected", error: null, fix: null });
          return servers.find((s) => s.id === existing.id);
        }
        const info = serverInfo({ id: crypto.randomUUID().slice(0, 8), name, named: !!a.name, ssh: line });
        servers = [...servers, info];
        announce();
        return info;
      }
      case "trust_host_key": {
        await sleep(STEP / 2);
        if (takeFail()) throw "could not write /Users/you/.ssh/known_hosts: Permission denied (os error 13)";
        host(String(a.line)).login = null;
        return null;
      }
      case "set_server_on": {
        const id = String(a.id);
        const s = servers.find((x) => x.id === id)!;
        patch(id, { on: !!a.on, ...(a.on ? {} : { status: "disconnected", stage: null, error: null, fix: null }) });
        if (!a.on) return null;
        if (!s.ssh) {
          patch(id, { status: "connecting", error: null, fix: null });
          const mine = epoch;
          void sleep(STEP).then(() =>
            mine !== epoch
              ? undefined
              : takeFail()
              ? patch(id, { status: "disconnected", error: `could not reach ${s.url}: Connection refused (os error 61)` })
              : patch(id, { status: "connected" }),
          );
          return null;
        }
        void dial(s.ssh, (stage) => patch(id, { status: "connecting", stage, error: null, fix: null })).then((failed) =>
          patch(id, failed ? { status: "disconnected", stage: null, error: failed.message, fix: failed.fix } : { status: "connected", stage: null }),
        ).catch(() => {});
        return null;
      }
      case "remove_server":
        servers = servers.filter((s) => s.id !== a.id);
        announce();
        return null;
      case "rename_server": {
        const s = servers.find((x) => x.id === a.id)!;
        const name = String(a.name).trim();
        patch(s.id, { name: name || hostOf(s.ssh ?? s.url), named: !!name });
        return null;
      }
      case "reconnect_servers":
        return null;
      case "survey_server": {
        const line = String(a.line);
        await sleep(STEP * 1.5);
        if (takeFail()) throw FAIL.unreachable(hostOf(line));
        return structuredClone(host(line).survey);
      }
      case "install_on_server": {
        const line = String(a.line);
        const picks = a.picks as string[];
        const h = host(line);
        const script = installScript(line, picks);
        const fail = takeFail();
        const mine = epoch;
        for (const [i, text] of script.entries()) {
          if (fail && i === 6) {
            void emit("server_installing", { line, text: "curl: (6) Could not resolve host: dray.sh" });
            throw { message: `The install on ${hostOf(line)} did not finish.`, fix: null } satisfies Failure;
          }
          await sleep(lineDelay);
          stale(mine);
          void emit("server_installing", { line, text });
        }
        for (const t of h.survey.tools) if (picks.includes(t.id) && !h.stubborn.includes(t.id)) t.found = true;
        h.dray = "running";
        return null;
      }
      case "run_server_login":
        await sleep(STEP / 2);
        signIn(String(a.server), String(a.harness), (a.provider as string) ?? null, String(a.auth), true);
        return null;
      case "server_invoke":
        return core(String(a.cmd), (a.args ?? {}) as Record<string, unknown>, String(a.server));
      default:
        return core(cmd, a, "local");
    }
  },
  { shouldMockEvents: true },
);

// ── driving the real UI ───────────────────────────────────────────────────────

/// Clicks and keystrokes into the page, the reader's way in. Each scenario
/// gets its own, and a new scenario aborts the last one's.
function driver(signal: AbortSignal) {
  async function until<T>(find: () => T | null | undefined): Promise<T> {
    for (let waited = 0; ; waited += 50) {
      if (signal.aborted) throw new DOMException("superseded", "AbortError");
      const found = find();
      if (found) return found;
      if (waited > 15000) throw new Error("demo: the next step never appeared");
      await sleep(50);
    }
  }
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text && !b.disabled);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  return {
    click: async (text: string) => (await until(() => button(text))).click(),
    toggle: async (label: string) =>
      (await until(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`))).click(),
    type: async (selector: string, value: string) => {
      const input = await until(() => document.querySelector<HTMLInputElement>(selector));
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    wait: (ms: number) => sleep(ms).then(() => signal.aborted && Promise.reject(new DOMException("superseded", "AbortError"))),
  };
}
type Drive = ReturnType<typeof driver>;

const SSH_FIELD = 'input[placeholder="ssh root@203.0.113.7"]';
async function addOverSsh(d: Drive, submit = true) {
  await d.click("Add server");
  await d.type(SSH_FIELD, LINE);
  await d.type('input[placeholder="vps"]', "vps");
  if (submit) await d.click("Add");
}
/// Add, find no Dray, install it with gh, land on the logins.
async function toLogins(d: Drive) {
  await addOverSsh(d);
  await d.toggle("Install GitHub CLI");
  await d.click("Install");
}

// ── scenarios ─────────────────────────────────────────────────────────────────

type Scenario = {
  id: string;
  label: string;
  tab: "servers" | "accounts";
  /// The selected session's directory; a `dray://` one picks that server on Accounts.
  cwd?: string;
  /// The backend's state before the page mounts.
  setup?: () => void;
  drive?: (d: Drive) => Promise<unknown>;
};

const VPS = (over: Partial<ServerInfo> = {}) => serverInfo({ id: "vps1", name: "vps", ssh: LINE, ...over });

const GROUPS: { title: string; scenarios: Scenario[] }[] = [
  {
    title: "Servers page",
    scenarios: [
      { id: "mac", label: "Only This Mac", tab: "servers" },
      {
        id: "two",
        label: "One up, one down",
        tab: "servers",
        setup: () => {
          servers = [
            VPS(),
            serverInfo({
              id: "tail",
              name: "studio",
              url: "ws://100.64.0.12:7317",
              status: "disconnected",
              error: "could not reach ws://100.64.0.12:7317: Connection refused (os error 61)",
            }),
          ];
        },
      },
      {
        id: "rows",
        label: "Every row state",
        tab: "servers",
        setup: () => {
          const row = (name: string, h: Partial<Host>, over: Partial<ServerInfo>) => {
            const line = `ssh root@${name}.example.net`;
            hosts.set(line, freshHost(h));
            const at = `${name}.example.net`;
            const failure = h.login
              ? FAIL[h.login](at, line)
              : h.dray === "missing"
                ? FAIL.missing(at)
                : h.dray === "never"
                  ? FAIL.neverRun(at)
                  : null;
            return serverInfo({ id: name, name, ssh: line, status: "disconnected", error: failure?.message ?? null, fix: failure?.fix ?? null, ...over });
          };
          servers = [
            row("logging-in", {}, { status: "connecting", stage: "connecting" }),
            row("finding", {}, { status: "connecting", stage: "finding" }),
            row("starting", {}, { status: "connecting", stage: "starting" }),
            row("new-host", { login: "unknownHost" }, {}),
            row("rekeyed", { login: "changedKey" }, {}),
            row("password", { login: "password" }, {}),
            row("unreachable", { login: "unreachable" }, {}),
            row("bare", { dray: "missing" }, {}),
            row("never-run", { dray: "never" }, {}),
            row("off", {}, { on: false }),
          ];
        },
      },
    ],
  },
  {
    title: "Add server",
    scenarios: [
      { id: "add", label: "Empty", tab: "servers", drive: (d) => d.click("Add server") },
      { id: "add-ssh", label: "SSH line typed", tab: "servers", drive: (d) => addOverSsh(d, false) },
      {
        id: "add-token",
        label: "Address and token",
        tab: "servers",
        drive: async (d) => {
          await d.click("Add server");
          await d.click("Use an address and token instead");
          await d.type('input[placeholder="127.0.0.1:7317"]', "100.64.0.12:7317");
          await d.type('input[type="password"]', "4f1c9a7e2b6d0c3f8a5e1d7b9c2a4f6e");
          await d.type('input[placeholder="vps"]', "studio");
        },
      },
      {
        id: "add-stages",
        label: "Connecting, each stage",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ dray: "stopped" })),
        drive: (d) => addOverSsh(d),
      },
      {
        id: "add-new-host",
        label: "Never seen this host",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ login: "unknownHost" })),
        drive: (d) => addOverSsh(d),
      },
      {
        id: "add-rekeyed",
        label: "Host key changed",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ login: "changedKey" })),
        drive: (d) => addOverSsh(d),
      },
      {
        id: "add-password",
        label: "Key refused, wants a password",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ login: "password" })),
        drive: (d) => addOverSsh(d),
      },
      {
        id: "add-unreachable",
        label: "Can't reach it",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ login: "unreachable" })),
        drive: (d) => addOverSsh(d),
      },
      {
        id: "add-never-run",
        label: "Dray there, never run",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ dray: "never" })),
        drive: (d) => addOverSsh(d),
      },
    ],
  },
  {
    title: "Install Dray",
    scenarios: [
      {
        id: "missing",
        label: "Dray missing: the pick-list",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ dray: "missing" })),
        drive: (d) => addOverSsh(d),
      },
      {
        id: "git-admin",
        label: "git needs admin",
        tab: "servers",
        setup: () =>
          hosts.set(
            LINE,
            freshHost({
              dray: "missing",
              survey: { os: "Linux", tools: tools(["codex"]), gitCommand: "sudo sh -c 'apt-get update && apt-get install -y git'" },
            }),
          ),
        drive: (d) => addOverSsh(d),
      },
      {
        id: "not-linux",
        label: "Not Linux",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ dray: "missing", survey: { os: "Darwin", tools: tools(["git"]), gitCommand: null } })),
        drive: (d) => addOverSsh(d),
      },
      {
        id: "installing",
        label: "Installing, with progress",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ dray: "missing" })),
        drive: async (d) => {
          await addOverSsh(d);
          await d.toggle("Install GitHub CLI");
          await d.toggle("Install Claude Code");
          await d.click("Install");
        },
      },
      {
        id: "partial",
        label: "A tool did not install",
        tab: "servers",
        setup: () => {
          lineDelay = 60;
          hosts.set(LINE, freshHost({ dray: "missing", stubborn: ["gh"] }));
        },
        drive: async (d) => {
          await addOverSsh(d);
          await d.toggle("Install GitHub CLI");
          await d.click("Install");
        },
      },
      {
        id: "install-failed",
        label: "Install failed",
        tab: "servers",
        setup: () => hosts.set(LINE, freshHost({ dray: "missing" })),
        drive: async (d) => {
          await addOverSsh(d);
          await d.toggle("Install GitHub CLI");
          setFailNext(true);
          await d.click("Install");
        },
      },
      {
        id: "logins",
        label: "Logins on the server",
        tab: "servers",
        setup: () => {
          lineDelay = 0;
          hosts.set(LINE, freshHost({ dray: "missing" }));
        },
        drive: (d) => toLogins(d),
      },
    ],
  },
  {
    title: "Accounts",
    scenarios: [
      { id: "accounts-mac", label: "This Mac, a server added", tab: "accounts", setup: () => (servers = [VPS()]) },
      {
        id: "accounts-remote",
        label: "A server picked",
        tab: "accounts",
        cwd: "dray://vps1/root/app",
        setup: () => (servers = [VPS()]),
      },
    ],
  },
];
const SCENARIOS = GROUPS.flatMap((g) => g.scenarios);

let running: AbortController | null = null;
function start(scenario: Scenario) {
  running?.abort();
  epoch++;
  running = new AbortController();
  servers = [];
  hosts = new Map();
  accounts = new Map();
  lineDelay = 260;
  setFailNext(false);
  scenario.setup?.();
  announce();
  const d = driver(running.signal);
  // A frame on, so the remounted page is there to be clicked.
  void sleep(100)
    .then(() => scenario.drive?.(d))
    .catch((e) => e?.name !== "AbortError" && console.error(e));
}

// ── the page ──────────────────────────────────────────────────────────────────

function useFailNext(): boolean {
  return useSyncExternalStore(
    (l) => (failListeners.add(l), () => void failListeners.delete(l)),
    () => failNext,
  );
}

function Demo() {
  const [picked, setPicked] = useState<{ scenario: Scenario; run: number }>({ scenario: SCENARIOS[0], run: 0 });
  const fail = useFailNext();
  const integrations = useIntegrations(false);
  // Remembered across reloads, since every edit reloads the page.
  const [barShown, setBarShown] = useState(() => localStorage.getItem("demo.serverSetup.bar") !== "hidden");
  const showBar = (shown: boolean) => {
    localStorage.setItem("demo.serverSetup.bar", shown ? "shown" : "hidden");
    setBarShown(shown);
  };
  const pick = (scenario: Scenario) => {
    start(scenario);
    setPicked((prev) => ({ scenario, run: prev.run + 1 }));
  };

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col">
        {/* Over a dialog's overlay, and clickable through Radix's `pointer-events:
            none` on the body, so the next state is one click from any other. */}
        {!barShown && (
          <button
            type="button"
            onClick={() => showBar(true)}
            className="pointer-events-auto fixed top-2 right-2 z-60 rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            Show states
          </button>
        )}
        <div
          className={cn(
            "pointer-events-auto relative z-60 flex shrink-0 bg-background flex-wrap items-start gap-x-6 gap-y-2 border-b border-border px-4 py-2.5 text-xs",
            !barShown && "hidden",
          )}
        >
          {GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              <span className="text-muted-foreground">{group.title}</span>
              <div className="flex flex-wrap gap-1">
                {group.scenarios.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => pick(s)}
                    className={cn(
                      "rounded-md border border-border px-2 py-1",
                      s === picked.scenario && "bg-foreground text-background",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Backend</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 py-1">
                <input type="checkbox" checked={fail} onChange={(e) => setFailNext(e.target.checked)} />
                Fail the next step
              </label>
              <a className="underline" href="/demo/servers.html">
                Against real servers →
              </a>
              <button type="button" onClick={() => showBar(false)} className="rounded-md border border-border px-2 py-1">
                Hide
              </button>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <SettingsPage
            key={picked.run}
            open
            onClose={() => {}}
            initialTab={picked.scenario.tab}
            projects={[]}
            spaces={[]}
            onSetProjectSpace={() => {}}
            onRemoveProject={() => {}}
            onCreateSpace={() => {}}
            onRenameSpace={() => {}}
            onRemoveSpace={() => {}}
            onMoveSpace={() => {}}
            onMoveProject={() => {}}
            autoHideSidebar={false}
            onAutoHideSidebarChange={() => {}}
            autoHidePanel={false}
            onAutoHidePanelChange={() => {}}
            panelSide="right"
            onPanelSideChange={() => {}}
            integrations={integrations}
            updateStatus={null}
            updateManual="idle"
            updateBlocked={false}
            onCheckUpdates={() => {}}
            onInstallUpdate={() => {}}
            updateChannel="stable"
            onUpdateChannelChange={() => {}}
            cwd={picked.scenario.cwd ?? "/Users/you/code/dray"}
          />
        </div>
      </div>
      <div className="pointer-events-auto relative z-60">
        <DemoThemeBar />
      </div>
    </TooltipProvider>
  );
}

start(SCENARIOS[0]);
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);

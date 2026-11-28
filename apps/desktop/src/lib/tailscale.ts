import type { TailscaleNeed } from "@/types/events";

/// Tailscale's admin page for HTTPS certificates, where `tailscale serve`
/// named no page of its own.
export const TAILSCALE_DNS_PAGE = "https://login.tailscale.com/admin/dns";
export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

/// The prompt a reader hands their own agent where Dray can't set Tailscale
/// up itself. Every step, whichever one is missing: an agent checks each
/// cheaply, and a prompt naming one step goes stale the moment that one is done.
export function agentPrompt(machine: "mac" | "linux" | "windows" | null): string {
  const where = machine === "mac" ? "Mac" : machine === "windows" ? "PC" : "machine";
  const steps = [
    `Install Tailscale if it isn't installed (${TAILSCALE_DOWNLOAD}).`,
    "Make sure Tailscale is running and signed in to my tailnet: `tailscale status` should list this machine.",
    `Make sure the tailnet has MagicDNS and HTTPS Certificates on (${TAILSCALE_DNS_PAGE}).`,
  ];
  if (machine !== "mac" && machine !== "windows") {
    steps.push("Let my user change Tailscale's settings without sudo: `sudo tailscale set --operator=$USER`.");
  }
  return [
    `Set up Tailscale on this ${where} so the Dray server on it can be reached over my tailnet.`,
    "",
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "Don't run `tailscale serve` yourself; Dray does that once this is done. Tell me when a step needs me, like signing in in a browser.",
  ].join("\n");
}

/// The row's one sentence for what Tailscale still wants here.
export function needLine(need: TailscaleNeed, machine: string): string {
  switch (need.kind) {
    case "install":
      return `Tailscale isn't installed on this ${machine}.`;
    case "start":
      return "Tailscale isn't running.";
    case "sign_in":
      return `Sign in to Tailscale on this ${machine}.`;
    case "https":
      return "Turn on HTTPS certificates for your tailnet.";
    case "operator":
      return "Let Dray run tailscale serve.";
    case "taken":
      return `Tailscale already serves ${need.target} here.`;
  }
}

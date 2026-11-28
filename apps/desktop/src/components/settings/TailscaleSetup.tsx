import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import CommandChip from "@/components/settings/CommandChip";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { useCopied } from "@/hooks/useCopied";
import { DEVICE, MACHINE } from "@/lib/platform";
import { agentPrompt, needLine, TAILSCALE_DNS_PAGE, TAILSCALE_DOWNLOAD } from "@/lib/tailscale";
import { invoke } from "@/lib/transport";
import type { TailscaleNeed } from "@/types/events";

/// What Tailscale still wants on this machine before it can serve here: one
/// line, the button that does it where Dray can, else a page or a command and
/// a prompt for the reader's own agent. The server looks again every few
/// seconds, so there is no Check again.
export default function TailscaleSetup({ need, server }: { need: TailscaleNeed; server: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopied();

  const fix = () => {
    setBusy(true);
    setError(null);
    invoke<string | null>("remote_access_fix", {}, server)
      .then((page) => (page ? openUrl(page) : undefined))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const open = (url: string) => () => void openUrl(url).catch(console.error);

  let action = null;
  let command: string | null = null;
  switch (need.kind) {
    case "install":
      action = need.fix ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={fix}>
          {busy && <Spinner className="size-3.5" />}
          {busy ? "Installing…" : "Install Tailscale"}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={open(TAILSCALE_DOWNLOAD)}>
          Download
        </Button>
      );
      break;
    case "start":
      if (need.fix)
        action = (
          <Button variant="secondary" size="sm" disabled={busy} onClick={fix}>
            {busy && <Spinner className="size-3.5" />}
            Start Tailscale
          </Button>
        );
      break;
    case "sign_in":
      action = need.url ? (
        <Button variant="secondary" size="sm" onClick={open(need.url)}>
          Sign in
        </Button>
      ) : need.fix ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={fix}>
          {busy && <Spinner className="size-3.5" />}
          Sign in
        </Button>
      ) : null;
      if (!action) command = "sudo tailscale up --operator=$USER";
      break;
    case "https":
      action = (
        <Button variant="secondary" size="sm" onClick={open(need.url ?? TAILSCALE_DNS_PAGE)}>
          Turn on
        </Button>
      );
      break;
    case "operator":
      command = `sudo tailscale set --operator=${need.user || "$USER"}`;
      break;
    case "taken":
      command = "tailscale serve --https=443 off";
      break;
  }
  // Only where Dray can't do it with one press, and a page or a line won't do.
  const fixable = "fix" in need && need.fix;
  const prompt = !fixable && need.kind !== "https" && need.kind !== "taken";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-7 items-center gap-1.5">
        <span className="min-w-0 flex-1 text-ui text-muted-foreground">{error ?? needLine(need, MACHINE)}</span>
        {prompt && (
          <Button variant="ghost" size="sm" onClick={() => void copy(agentPrompt(DEVICE))}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            Prompt for your agent
          </Button>
        )}
        {action}
      </div>
      {command && <CommandChip command={command} />}
    </div>
  );
}

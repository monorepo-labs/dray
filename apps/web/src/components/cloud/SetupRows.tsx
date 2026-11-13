import { Check } from "lucide-react";

import { MUTED, ROWS, SECONDARY } from "@/components/account/styles";
import type { CloudAccount } from "@/lib/cloud/account";

/// GitHub, Claude and Codex: each connected, or what connecting takes.
export function SetupRows({ github, agents }: Pick<CloudAccount, "github" | "agents">) {
  const reach = github.repos === null ? "every repo" : `${github.repos.length} ${github.repos.length === 1 ? "repo" : "repos"}`;
  const anyAgent = agents.claude.connected || agents.codex.connected;
  return (
    <div className={ROWS}>
      <Row
        title="GitHub"
        done={github.installed}
        detail={
          github.installed
            ? `The Dray GitHub App is on ${github.account}, for ${reach}.`
            : "Install the Dray GitHub App on the repos Cloud may clone and push to."
        }
        action={
          <a href={github.installUrl} target="_blank" rel="noopener noreferrer" className={SECONDARY}>
            {github.installed ? "Change repos" : "Install"}
          </a>
        }
      />
      {(["claude", "codex"] as const).map((agent) => {
        const { connected, connectUrl } = agents[agent];
        const name = agent === "claude" ? "Claude" : "Codex";
        return (
          <Row
            key={agent}
            title={name}
            done={connected}
            detail={
              connected
                ? `Machines sign in to ${name} with your subscription.`
                : anyAgent
                  ? `Optional. Connect it to run ${name} tasks too.`
                  : `Connect your ${name} subscription, or ${agent === "claude" ? "Codex" : "Claude"}'s.`
            }
            action={
              connected ? null : connectUrl ? (
                <a href={connectUrl} className={SECONDARY}>
                  Connect
                </a>
              ) : (
                <span className={`text-[13px] ${MUTED}`}>Opens soon</span>
              )
            }
          />
        );
      })}
    </div>
  );
}

function Row({ title, done, detail, action }: { title: string; done: boolean; detail: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        aria-label={done ? "Done" : "Not done"}
        className={`flex size-5 shrink-0 items-center justify-center rounded-full ${done ? "bg-white text-[#0B0B0F] light:bg-[#0A0A0A] light:text-white" : "border border-white/30 light:border-black/25"}`}
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] leading-5">{title}</p>
        <p className={`text-[13px] leading-5 ${MUTED}`}>{detail}</p>
      </div>
      {action}
    </div>
  );
}

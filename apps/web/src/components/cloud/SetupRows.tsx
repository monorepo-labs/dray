import { Check } from "lucide-react";

import { MUTED, ROWS, SECONDARY } from "@/components/account/styles";
import type { CloudAccount } from "@/lib/cloud/account";

/// GitHub, Claude and Codex: each connected, what connecting takes, or why
/// it can't be done today.
export function SetupRows({ github, agents }: Pick<CloudAccount, "github" | "agents">) {
  return (
    <div className={ROWS}>
      <Row
        title="GitHub"
        done={github.connected}
        detail={
          github.connected
            ? `Linked as ${github.login}. A task's repo must be one the Dray GitHub App is installed on.`
            : "Install the Dray GitHub App on the repos Cloud may clone and push to."
        }
        action={
          <a href={github.connectUrl} className={SECONDARY}>
            {github.connected ? "Change repos" : "Install"}
          </a>
        }
      />
      {(["claude", "codex"] as const).map((agent) => {
        const { available, connected, connectUrl, note } = agents[agent];
        const name = agent === "claude" ? "Claude" : "Codex";
        return (
          <Row
            key={agent}
            title={name}
            done={connected}
            detail={
              connected
                ? `Machines run ${name} on your own login.`
                : available
                  ? `Connect your ${name} login. Model usage stays on your ${name} plan.`
                  : (note ?? "Not available yet.")
            }
            action={
              !connected && connectUrl ? (
                <a href={connectUrl} className={SECONDARY}>
                  Connect
                </a>
              ) : null
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

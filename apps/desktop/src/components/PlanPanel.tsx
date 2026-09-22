import { Markdown } from "@/components/chat/Markdown";
import { usePlan } from "@/lib/plan";

/// The plan a session's agent put up for approval, drawn as the markdown it is.
///
/// Read-only, and not because it is unfinished: a plan is the agent's proposal
/// and the reader answers it on the card, in the composer, or by letting the
/// work run. An editor here would be a fourth way to say yes that the agent
/// never reads.
export default function PlanPanel({ sessionId }: { sessionId: string | null }) {
  const plan = usePlan(sessionId);

  if (!plan) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <p className="text-ui text-muted-foreground">No plan yet.</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 text-chat">
      <Markdown>{plan}</Markdown>
    </div>
  );
}

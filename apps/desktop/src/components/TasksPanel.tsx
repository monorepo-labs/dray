import Orb from "@/components/Orb";
import type { CrewRow } from "@/lib/crew";
import { cn } from "@/lib/utils";

/// The order the groups are drawn in, and the words each is headed by.
const GROUPS = [
  { key: "waiting", label: "Waiting on you" },
  { key: "working", label: "Working" },
  { key: "done", label: "Done" },
] as const;

type GroupKey = (typeof GROUPS)[number]["key"];

function groupOf(row: CrewRow): GroupKey {
  if (row.asking) return "waiting";
  if (row.busy) return "working";
  return "done";
}

/// A bot's Tasks tab: every session it handed work to, at any depth. They run
/// hidden from the sidebar, so this is where they are found; their cards and
/// reports already reach the bot's chat, so nothing here has to be opened.
export default function TasksPanel({
  rows,
  onOpen,
}: {
  rows: CrewRow[];
  onOpen: (sessionId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-ui text-muted-foreground">
        Nothing handed off yet. Work this bot starts shows up here.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 py-2">
      {GROUPS.map(({ key, label }) => {
        const group = rows.filter((r) => groupOf(r) === key);
        if (group.length === 0) return null;
        return (
          <section key={key} className="flex flex-col">
            <h3 className="px-3 pb-1 text-ui text-muted-foreground/70">{label}</h3>
            {group.map((row) => (
              <button
                key={row.item.sessionId}
                type="button"
                onClick={() => onOpen(row.item.sessionId)}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-3 text-left text-ui text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              >
                <span
                  className={cn(
                    "truncate",
                    row.asking ? "text-accent-command" : row.unread && "text-accent-add",
                  )}
                >
                  {row.item.title}
                </span>
                {(row.asking || row.unread) && (
                  <span className="sr-only">{row.asking ? "Waiting for you" : "Unread"}</span>
                )}
                {row.busy && (
                  <span className="ml-auto flex shrink-0">
                    <Orb state="working" label="Working" />
                  </span>
                )}
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

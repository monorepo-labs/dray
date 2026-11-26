import { KeyIcon } from "@heroicons/react/16/solid";
import { Check, Search } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { matchSecrets, SECRET_SEARCH_AFTER } from "@/lib/secretPicker";
import { cn } from "@/lib/utils";

/// A row's height (`h-8`), and how many fit `max-h-72` before it scrolls.
const ROW = 32;
const ROWS_SHOWN = 9;

/// The secret card's ⌄: every secret saved on the answering machine, the
/// current pick ticked. Picking one makes it the card's Use saved; nothing is
/// sent until that is pressed. A dropdown stopped reading at ten names, hence a
/// dialog, with a search once there are more than a handful.
export default function SecretPicker({
  names,
  pick,
  asked,
  machine,
  onPick,
  onClose,
}: {
  names: string[];
  pick: string;
  /// The name the agent asked for, which it gets whichever is picked.
  asked: string;
  machine: string;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const searchable = names.length > SECRET_SEARCH_AFTER;
  const [query, setQuery] = useState("");
  const shown = matchSecrets(names, query);
  const listRef = useRef<HTMLDivElement>(null);

  const choose = (name: string) => {
    onPick(name);
    onClose();
  };

  // Arrows walk the rows, and from the search into them.
  const walk = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (rows.length === 0) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1;
    if (next < 0) listRef.current?.closest("[data-slot=dialog-content]")?.querySelector<HTMLInputElement>("input")?.focus();
    else rows[next].focus();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="grid-cols-[minmax(0,1fr)] gap-3"
        onKeyDown={walk}
        // Without a search, Radix would focus the close cross; the ticked row is
        // where a keyboard wants to start.
        onOpenAutoFocus={(e) => {
          if (searchable) return;
          e.preventDefault();
          listRef.current?.querySelector<HTMLButtonElement>("[aria-current=true]")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Use a saved secret</DialogTitle>
          <DialogDescription>
            Saved on {machine}. The agent gets it as <span className="font-mono">{asked}</span>.
          </DialogDescription>
        </DialogHeader>
        {searchable && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              type="text"
              placeholder="Search secrets"
              aria-label="Search secrets"
              className="pl-8"
              value={query}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown.length > 0) {
                  e.preventDefault();
                  choose(shown[0]);
                }
              }}
            />
          </div>
        )}
        <div
          ref={listRef}
          className="-mx-2 flex max-h-72 flex-col overflow-y-auto"
          // Held at its full height while a search narrows it, or the centred
          // dialog jumps under the reader's typing.
          style={searchable ? { height: Math.min(names.length, ROWS_SHOWN) * ROW } : undefined}
        >
          {shown.length === 0 ? (
            <p className="px-2 py-1.5 text-ui text-muted-foreground">No saved secret matches.</p>
          ) : (
            shown.map((n) => (
              <button
                key={n}
                type="button"
                aria-current={n === pick}
                onClick={() => choose(n)}
                className={cn(
                  "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm outline-none",
                  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                )}
              >
                <KeyIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono">{n}</span>
                {n === pick && <Check className="size-4 shrink-0" aria-hidden />}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

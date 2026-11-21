import { useMemo, useState } from "react";
import GitBranchIcon from "@/components/icons/GitBranchIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { worktreeBranchOptions } from "@/lib/worktreeBranches";
import type { BranchList } from "@/types/events";

/// Past this many branches the menu grows a filter box.
const FILTER_FROM = 8;

/// Which branch a new task's worktree starts on. `value` null is the default
/// branch, fetched from its remote as every task always started; any other
/// pick is worked on by its own name — see `create_worktree_from_branch`.
export default function WorktreeBranchSelector({
  branches,
  value,
  onSelect,
  onOpen,
}: {
  branches: BranchList | null;
  value: string | null;
  onSelect: (branch: string | null) => void;
  onOpen?: () => void;
}) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => (branches ? worktreeBranchOptions(branches, query) : null), [branches, query]);
  if (!branches || !options) return null;
  const { defaultBranch, local, remote } = options;
  const total = branches.branches.length + (branches.remoteBranches?.length ?? 0);
  // A repo with no remote and one branch has nothing to pick between, and
  // nothing worth stating either.
  if (!branches.defaultBase && total < 2) return null;

  const label = value ?? branches.defaultBase ?? branches.current;
  const searching = query.trim() !== "";

  return (
    <DropdownMenu onOpenChange={(open) => (open ? onOpen?.() : setQuery(""))}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="max-w-48 gap-1.5 px-1.5 text-ui text-muted-foreground"
        >
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="truncate">from {label}</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="max-h-80 min-w-52 max-w-80 overflow-y-auto">
        {total > FILTER_FROM && (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // The menu's typeahead would otherwise eat every letter typed here.
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "Escape") e.stopPropagation();
            }}
            placeholder="Filter branches"
            className="mb-1 w-full rounded-md bg-transparent px-2 py-1 text-ui outline-none placeholder:text-muted-foreground/60"
          />
        )}

        <DropdownMenuRadioGroup
          value={value ?? ""}
          onValueChange={(b) => onSelect(b === "" || b === defaultBranch ? null : b)}
        >
          {defaultBranch && (
            <DropdownMenuRadioItem value="" className="text-ui">
              <span className="truncate">{defaultBranch}</span>
              <span className="ml-auto pl-3 text-muted-foreground/60">latest</span>
            </DropdownMenuRadioItem>
          )}
          {/* Browsing groups by where a branch lives; a query ranks them flat. */}
          {!searching && local.length > 0 && remote.length > 0 && (
            <DropdownMenuLabel className="text-ui font-normal text-muted-foreground">Local</DropdownMenuLabel>
          )}
          {local.map((b) => (
            <DropdownMenuRadioItem key={`l:${b}`} value={b} className="text-ui">
              <span className="truncate">{b}</span>
            </DropdownMenuRadioItem>
          ))}
          {!searching && remote.length > 0 && (
            <DropdownMenuLabel className="text-ui font-normal text-muted-foreground">On remote</DropdownMenuLabel>
          )}
          {remote.map((b) => (
            <DropdownMenuRadioItem key={`r:${b}`} value={b} className="text-ui">
              <span className="truncate">{b}</span>
              {searching && <span className="ml-auto pl-3 text-muted-foreground/60">remote</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        {searching && !defaultBranch && local.length + remote.length === 0 && (
          <DropdownMenuLabel className="text-ui font-normal text-muted-foreground">No branch matches</DropdownMenuLabel>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

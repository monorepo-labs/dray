import { Folder, FolderPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { basename } from "@/lib/format";
import type { Project } from "@/types/events";

export default function ProjectSelector({
  projects,
  value,
  onSelect,
  onAttach,
}: {
  projects: Project[];
  value: string | null;
  onSelect: (path: string) => void;
  onAttach: () => void;
}) {
  // Nothing to choose between yet, so the trigger does the only useful thing
  // rather than opening a menu whose sole item is the same action.
  if (projects.length === 0) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onAttach}
        className="gap-1.5 px-1.5 text-ui text-muted-foreground"
      >
        <FolderPlus className="size-3.5 shrink-0" />
        Attach project
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-w-40 gap-1.5 px-1.5 text-ui text-muted-foreground"
            >
              {/* Same slot and same size as the branch picker's glyph beside it —
                  the row reads as one set of controls or as three unrelated ones.
                  Filled, since lucide draws a folder as an outline and at 14px the
                  open shape reads as a shard rather than a folder. */}
              <Folder className="size-3.5 shrink-0 fill-current" />
              <span className="truncate">
                {value ? basename(value) : "Attach project"}
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {/* The chord steps to the next project rather than opening this menu,
            so it is only worth saying where there is a next one. */}
        {projects.length > 1 && (
          <TooltipContent side="top" className="max-w-none whitespace-nowrap">
            Next project
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>Shift</Kbd>
              <Kbd>P</Kbd>
            </KbdGroup>
          </TooltipContent>
        )}
      </Tooltip>

      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onSelect}>
          {projects.map((project) => (
            // Two projects can share a folder name, so the full path is the
            // tooltip rather than the label.
            <DropdownMenuRadioItem
              key={project.path}
              value={project.path}
              title={project.path}
              className="text-ui"
            >
              <span className="truncate">{project.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuItem onSelect={onAttach} className="text-ui">
          <FolderPlus />
          Attach project…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { FolderPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="max-w-40 px-1.5 text-ui text-muted-foreground"
        >
          <span className="truncate">
            {value ? basename(value) : "Attach project"}
          </span>
        </Button>
      </DropdownMenuTrigger>

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

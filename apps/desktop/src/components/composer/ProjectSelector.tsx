import { Folder, FolderPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ShortcutKeys from "@/components/ShortcutKeys";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { basename } from "@/lib/format";
import { serverConnected, serverName, useServers } from "@/lib/servers";
import { displayPath, LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
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
  // Picking a project picks its server, so the menu is grouped by server and
  // there is no server control anywhere else. One server draws no headings,
  // which is every reader who has added none.
  useServers();
  const groups = new Map<ServerId, Project[]>();
  for (const project of projects) {
    const server = serverOfPath(project.path);
    groups.set(server, [...(groups.get(server) ?? []), project]);
  }
  const grouped = groups.size > 1 || !groups.has(LOCAL);

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
                {value ? basename(displayPath(value)) : "Attach project"}
                {value && serverOfPath(value) !== LOCAL && (
                  <span className="text-muted-foreground/50">-{serverName(serverOfPath(value))}</span>
                )}
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {/* The chord steps to the next project rather than opening this menu,
            so it is only worth saying where there is a next one. */}
        {projects.length > 1 && (
          <TooltipContent side="top" className="max-w-none whitespace-nowrap">
            Next project
            <ShortcutKeys ids={["project.next"]} />
          </TooltipContent>
        )}
      </Tooltip>

      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onSelect}>
          {[...groups].map(([server, list]) => (
            <div key={server} role="group" aria-label={grouped ? serverName(server) : undefined}>
              {grouped && (
                <DropdownMenuLabel className="flex text-ui font-normal text-muted-foreground">
                  {serverName(server)}
                  {!serverConnected(server) && <span className="ml-auto pl-3 opacity-70">disconnected</span>}
                </DropdownMenuLabel>
              )}
              {list.map((project) => (
                // Two projects can share a folder name, so the full path is the
                // tooltip rather than the label. A disconnected server's
                // projects stay listed and cannot be picked: nothing could send.
                <DropdownMenuRadioItem
                  key={project.path}
                  value={project.path}
                  title={displayPath(project.path)}
                  disabled={!serverConnected(server)}
                  className="text-ui"
                >
                  <span className="truncate">{project.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </div>
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

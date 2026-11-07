import { Folder, FolderPlus } from "lucide-react";
import { useState } from "react";

import AttachProjectDialog from "@/components/composer/AttachProjectDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { groupProjects, lastUsedCheckout, soleServer } from "@/lib/projectGroups";
import { projectLabel, serverConnected, serverName, useServers } from "@/lib/servers";
import { displayPath, LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import type { Project } from "@/types/events";

export default function ProjectSelector({
  projects,
  value,
  onSelect,
  onAttached,
}: {
  projects: Project[];
  value: string | null;
  onSelect: (path: string) => void;
  onAttached: (server: ServerId, list: Project[]) => void;
}) {
  const [attaching, setAttaching] = useState(false);
  const onAttach = () => setAttaching(true);
  // Rendered beside whichever trigger is drawn, in the same slot, so it
  // survives the list going from none to one.
  const dialog = (
    <AttachProjectDialog
      open={attaching}
      onClose={() => setAttaching(false)}
      initialServer={value ? serverOfPath(value) : LOCAL}
      projects={projects}
      onAttached={onAttached}
    />
  );

  // One row per project. Picking it picks the machine last used, and
  // `MachineSelector` beside this is where that is changed.
  useServers();
  const groups = groupProjects(projects);
  const group = groups.find((g) => g.checkouts.some((p) => p.path === value));

  // `MachineSelector` names an attached project's machine, so this is only for
  // a path nothing lists any more.
  const trailing = !group && value && serverOfPath(value) !== LOCAL ? serverOfPath(value) : null;

  // Nothing to choose between yet, so the trigger does the only useful thing
  // rather than opening a menu whose sole item is the same action.
  if (projects.length === 0) {
    return (
      <>
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
        {dialog}
      </>
    );
  }

  return (
    <>
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
                  {group?.name ?? (value ? basename(displayPath(value)) : "Attach project")}
                  {trailing && <span className="text-muted-foreground/50">-{serverName(trailing)}</span>}
                </span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {/* The chord steps to the next project rather than opening this menu,
              so it is only worth saying where there is a next one. */}
          {groups.length > 1 && (
            <TooltipContent side="top" className="max-w-none whitespace-nowrap">
              Next project
              <ShortcutKeys ids={["project.next"]} />
            </TooltipContent>
          )}
        </Tooltip>
  
        <DropdownMenuContent align="start" className="w-auto min-w-52">
          <DropdownMenuRadioGroup
            value={group?.key ?? ""}
            onValueChange={(key) => {
              const picked = groups.find((g) => g.key === key);
              if (picked) onSelect(lastUsedCheckout(picked.checkouts).path);
            }}
          >
            {groups.map(({ key, name, checkouts }) => {
              const reachable = checkouts.some((p) => serverConnected(serverOfPath(p.path)));
              // Two projects can share a folder name, so the full path is the
              // tooltip rather than the label. A project with no machine up
              // stays listed and cannot be picked: nothing could send.
              return (
                <DropdownMenuRadioItem
                  key={key}
                  value={key}
                  title={checkouts.length === 1 ? displayPath(checkouts[0].path) : undefined}
                  disabled={!reachable}
                  className="text-ui"
                >
                  <span className="truncate">{projectLabel(name, soleServer(checkouts))}</span>
                  {!reachable && <span className="ml-auto shrink-0 pl-3 opacity-70">disconnected</span>}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
  
          <DropdownMenuItem onSelect={onAttach} className="text-ui">
            <FolderPlus />
            Attach project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

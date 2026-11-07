import { Check, Folder, FolderPlus } from "lucide-react";
import { useState } from "react";

import AttachProjectDialog from "@/components/composer/AttachProjectDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  const [menuOpen, setMenuOpen] = useState(false);
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

  // One row per project. Picking it picks its machine, the one last used, so
  // the reader only meets machines by hovering a project that has several.
  useServers();
  const groups = groupProjects(projects);

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
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
          {groups.length > 1 && (
            <TooltipContent side="top" className="max-w-none whitespace-nowrap">
              Next project
              <ShortcutKeys ids={["project.next"]} />
            </TooltipContent>
          )}
        </Tooltip>
  
        <DropdownMenuContent align="start" className="w-auto min-w-52">
          <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onSelect}>
            {groups.map(({ key, name, checkouts }) => {
              const label = projectLabel(name, soleServer(checkouts));
              const reachable = checkouts.some((p) => serverConnected(serverOfPath(p.path)));
              const down = !reachable && <span className="ml-auto shrink-0 pl-3 opacity-70">disconnected</span>;
              if (checkouts.length === 1) {
                // Two projects can share a folder name, so the full path is the
                // tooltip rather than the label. A disconnected server's
                // projects stay listed and cannot be picked: nothing could send.
                return (
                  <DropdownMenuRadioItem
                    key={key}
                    value={checkouts[0].path}
                    title={displayPath(checkouts[0].path)}
                    disabled={!reachable}
                    className="text-ui"
                  >
                    <span className="truncate">{label}</span>
                    {down}
                  </DropdownMenuRadioItem>
                );
              }
              const pickLastUsed = () => {
                onSelect(lastUsedCheckout(checkouts).path);
                setMenuOpen(false);
              };
              return (
                <DropdownMenuSub key={key}>
                  {/* A click or Enter takes the last machine used, so a new task
                      costs nothing extra. The submenu is only for changing it. */}
                  <DropdownMenuSubTrigger
                    disabled={!reachable}
                    onClick={pickLastUsed}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      pickLastUsed();
                    }}
                    trailingIcon={
                      checkouts.some((p) => p.path === value) ? <Check className="ml-auto" /> : down || undefined
                    }
                    className="text-ui data-disabled:pointer-events-none data-disabled:opacity-50"
                  >
                    <span className="truncate">{label}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-w-96 min-w-40">
                    {checkouts.map((checkout) => {
                      const server = serverOfPath(checkout.path);
                      return (
                        <DropdownMenuRadioItem
                          key={checkout.path}
                          value={checkout.path}
                          title={displayPath(checkout.path)}
                          disabled={!serverConnected(server)}
                          className="text-ui"
                        >
                          <span className="truncate">{checkoutLabel(checkout, checkouts)}</span>
                          {!serverConnected(server) && <span className="ml-auto pl-3 opacity-70">disconnected</span>}
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
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

/// A checkout among its project's others: its machine, its path where that
/// machine holds two, and the path alone where every one is on one machine.
function checkoutLabel(checkout: Project, checkouts: Project[]): string {
  const server = serverOfPath(checkout.path);
  const path = displayPath(checkout.path);
  if (soleServer(checkouts)) return path;
  const twoHere = checkouts.filter((p) => serverOfPath(p.path) === server).length > 1;
  return twoHere ? `${serverName(server)} · ${path}` : serverName(server);
}

import ServerFilledIcon from "@/components/icons/ServerFilledIcon";
import ShortcutKeys from "@/components/ShortcutKeys";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename } from "@/lib/format";
import { checkoutsOf, nextCheckout, soleServer } from "@/lib/projectGroups";
import { serverConnected, serverName, useServers } from "@/lib/servers";
import { displayPath, LOCAL, serverOfPath } from "@/lib/transport";
import type { Project } from "@/types/events";

/// Where a new task runs, among the picked project's checkouts. A project only
/// on This Mac draws nothing, since no name is what says local. One checkout on
/// a server is named and disabled: worth saying, with nothing to choose.
export default function MachineSelector({
  projects,
  value,
  onSelect,
}: {
  projects: Project[];
  value: string | null;
  onSelect: (path: string) => void;
}) {
  useServers();
  const checkouts = value ? checkoutsOf(projects, value) : [];
  const current = checkouts.find((p) => p.path === value);
  if (!current) return null;
  const only = checkouts.length === 1;
  if (only && serverOfPath(current.path) === LOCAL) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={only}
              className="max-w-40 gap-1.5 px-1.5 text-ui text-muted-foreground disabled:opacity-100"
            >
              <ServerFilledIcon className="size-3.5 shrink-0" />
              <span className="truncate">{checkoutLabel(current, checkouts, basename)}</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {/* Same test as the chord's own gate in `App`, so the hint never names
            a key that is unbound — every other machine offline included. */}
        {nextCheckout(checkouts, current.path) && (
          <TooltipContent side="top" className="max-w-none whitespace-nowrap">
            Next server
            <ShortcutKeys ids={["server.next"]} />
          </TooltipContent>
        )}
      </Tooltip>

      <DropdownMenuContent align="start" className="w-auto max-w-96 min-w-40">
        <DropdownMenuRadioGroup value={current.path} onValueChange={onSelect}>
          {checkouts.map((checkout) => {
            const reachable = serverConnected(serverOfPath(checkout.path));
            return (
              <DropdownMenuRadioItem
                key={checkout.path}
                value={checkout.path}
                title={displayPath(checkout.path)}
                disabled={!reachable}
                className="text-ui"
              >
                <span className="truncate">{checkoutLabel(checkout, checkouts, (path) => path)}</span>
                {!reachable && <span className="ml-auto shrink-0 pl-3 opacity-70">disconnected</span>}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// A checkout among its project's others: its machine, its folder where that
/// machine holds two, and the folder alone where every one is on This Mac.
function checkoutLabel(checkout: Project, checkouts: Project[], folder: (path: string) => string): string {
  const server = serverOfPath(checkout.path);
  const path = folder(displayPath(checkout.path));
  if (soleServer(checkouts) === LOCAL) return path;
  const twoHere = checkouts.filter((p) => serverOfPath(p.path) === server).length > 1;
  return twoHere ? `${serverName(server)} · ${path}` : serverName(server);
}

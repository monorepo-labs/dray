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
import { cloudReady, githubSlug, isCloud, onCloud, setCloudPick, useCloud, useCloudPicks } from "@/lib/cloud";
import { basename } from "@/lib/format";
import { checkoutsOf, nextCheckout, projectKey, soleServer } from "@/lib/projectGroups";
import { serverConnected, serverName, useServers } from "@/lib/servers";
import { displayPath, LOCAL, serverOfPath } from "@/lib/transport";
import type { Project } from "@/types/events";

/// The Cloud entry's radio value, which no path can be.
const CLOUD = "cloud:";

/// Where a new task runs, among the picked project's checkouts. A project only
/// on This Mac draws nothing, since no name is what says local. One checkout on
/// a server is named and disabled: worth saying, with nothing to choose.
///
/// Dray Cloud is one entry, on a project with a GitHub remote, whatever
/// machines hold it: a task there is placed on send, so no machine is picked.
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
  const cloud = useCloud();
  useCloudPicks();
  const checkouts = value ? checkoutsOf(projects, value) : [];
  const current = checkouts.find((p) => p.path === value);
  if (!current) return null;
  const offersCloud = cloudReady(cloud) && !!githubSlug(current.remote);
  const picked = offersCloud && onCloud(projects, current.path);
  // Cloud's own checkouts fold into its entry rather than listing one by one.
  const machines = offersCloud ? checkouts.filter((p) => !isCloud(serverOfPath(p.path))) : checkouts;
  const only = machines.length + (offersCloud ? 1 : 0) === 1;
  if (only && serverOfPath(current.path) === LOCAL) return null;
  const label = picked ? "Cloud" : checkoutLabel(current, machines, offersCloud, basename);

  const pick = (next: string) => {
    setCloudPick(projectKey(current), next === CLOUD);
    if (next !== CLOUD) onSelect(next);
  };

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
              <span className="truncate">{label}</span>
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
        <DropdownMenuRadioGroup value={picked ? CLOUD : current.path} onValueChange={pick}>
          {machines.map((checkout) => {
            const reachable = serverConnected(serverOfPath(checkout.path));
            return (
              <DropdownMenuRadioItem
                key={checkout.path}
                value={checkout.path}
                title={displayPath(checkout.path)}
                disabled={!reachable}
                className="text-ui"
              >
                <span className="truncate">{checkoutLabel(checkout, machines, offersCloud, (path) => path)}</span>
                {!reachable && <span className="ml-auto shrink-0 pl-3 opacity-70">disconnected</span>}
              </DropdownMenuRadioItem>
            );
          })}
          {offersCloud && (
            <DropdownMenuRadioItem value={CLOUD} className="text-ui">
              Cloud
            </DropdownMenuRadioItem>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// A checkout among its project's others: its machine, its folder where that
/// machine holds two, and the folder alone where every one is on This Mac —
/// unless Cloud sits beside them, which makes This Mac a choice to name.
function checkoutLabel(
  checkout: Project,
  checkouts: Project[],
  besideCloud: boolean,
  folder: (path: string) => string,
): string {
  const server = serverOfPath(checkout.path);
  const path = folder(displayPath(checkout.path));
  if (soleServer(checkouts) === LOCAL && !besideCloud) return path;
  const twoHere = checkouts.filter((p) => serverOfPath(p.path) === server).length > 1;
  return twoHere ? `${serverName(server)} · ${path}` : serverName(server);
}

import { useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";

import LinearIcon from "@/components/LinearIcon";
import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { useIntegrations } from "@/hooks/useIntegrations";
import { linearWorkspaces, workspaceFor, workspaceName } from "@/lib/linearWorkspace";
import { displayPath } from "@/lib/space";
import type { LinearFilter, Project, TrackerAccount } from "@/types/events";

/// The connected Linear workspaces, and which one each Space and project reads.
///
/// **Draws nothing until something is connected**, the rule the single row it
/// replaced kept: the Issues page is where connecting starts. Once one is, this
/// is where a second is added — the page's connect pane is for the reader with
/// none, and a form for "another" belongs beside the list it adds to.
///
/// The Spaces and Projects lists appear at two workspaces. With one there is
/// nothing to choose, and a column of menus each offering one answer is noise.
export default function LinearWorkspaces({
  integrations,
  projects,
  spaces,
  onSetProjectWorkspace,
  onClearProjectFilter,
}: {
  integrations: ReturnType<typeof useIntegrations>;
  projects: Project[];
  spaces: string[];
  onSetProjectWorkspace: (path: string, workspace: string | null) => void;
  /// Forgets a repo's saved issue filter. Saving happens on the issues page,
  /// where the filters are.
  onClearProjectFilter: (path: string) => void;
}) {
  const { busy, error, connect, disconnect, makeDefault, pinSpace } = integrations;
  const workspaces = linearWorkspaces(integrations.integrations);
  const pins = integrations.integrations?.linearSpacePins ?? {};

  /// One question at a time across every row, the transcription rows' pattern:
  /// two rows asking at once is two answers wanted for one press.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");

  if (workspaces.length === 0) return null;

  const choosing = workspaces.length > 1;
  const defaultName = workspaceName(workspaces, null);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h2 className="flex items-center gap-1.5 text-ui font-medium text-muted-foreground">
            <LinearIcon className="size-3.5" />
            Linear workspaces
          </h2>
          {!adding && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdding(true)}
              className="h-7 gap-1 px-2 text-ui text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-3.5" />
              Add workspace
            </Button>
          )}
        </div>

        {adding && (
          <form
            className="flex items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await connect(key)) {
                setKey("");
                setAdding(false);
              }
            }}
          >
            <Input
              autoFocus
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              // A key belongs to one workspace, so which one is added is
              // whichever the key was made in — said here, since there is no
              // workspace picker to say it for us.
              placeholder="lin_api_… from the workspace to add"
              aria-label="Linear API key"
              className="flex-1 text-ui"
            />
            <Button
              type="button"
              variant="ghost"
              className="text-ui"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !key.trim()} className="text-ui">
              Connect
            </Button>
          </form>
        )}

        {workspaces.map((workspace, i) => (
          <WorkspaceRow
            key={workspace.workspaceId ?? i}
            workspace={workspace}
            isDefault={i === 0}
            // Only where there is another to be the default instead.
            canMakeDefault={choosing && i > 0}
            confirming={confirming === (workspace.workspaceId ?? "")}
            busy={busy}
            onAsk={() => setConfirming(workspace.workspaceId ?? "")}
            onCancel={() => setConfirming(null)}
            onDisconnect={async () => {
              // No id is the default Linear never identified, and `null`
              // names the default.
              await disconnect(workspace.workspaceId ?? null);
              setConfirming(null);
            }}
            onMakeDefault={() => workspace.workspaceId && makeDefault(workspace.workspaceId)}
          />
        ))}

        {error && <p className="text-ui text-destructive">{error}</p>}
      </div>

      {choosing && spaces.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-ui font-medium text-muted-foreground">Spaces</h2>
          <p className="text-ui text-muted-foreground">
            Every project in a Space reads its workspace, unless the project picks its own.
          </p>
          {spaces.map((space) => (
            <div key={space} className="flex h-8 items-center justify-between gap-4">
              <span className="min-w-0 flex-1 truncate text-ui">{space}</span>
              <WorkspaceMenu
                workspaces={workspaces}
                value={pins[space] ?? null}
                inherit={`Default (${defaultName})`}
                onChange={(next) => pinSpace(space, next)}
              />
            </div>
          ))}
        </div>
      )}

      {/* With one workspace there is no pin to choose, but a saved filter is
          still worth seeing and clearing — so those projects list alone. */}
      {projects.some((p) => choosing || p.linearFilter) && (
        <div className="flex flex-col gap-3">
          <h2 className="text-ui font-medium text-muted-foreground">Projects</h2>
          {projects
            .filter((p) => choosing || p.linearFilter)
            .map((project) => {
              // What the project would read with no pin of its own, which is
              // what its first menu item has to name.
              const inherited = workspaceFor({ space: project.space }, pins, workspaces);
              const inheritLabel =
                inherited.from === "space"
                  ? `From ${project.space} (${workspaceName(workspaces, inherited.id)})`
                  : `Default (${defaultName})`;

              return (
                <div key={project.path} className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-ui font-medium">{project.name}</span>
                    <span className="truncate text-ui text-muted-foreground">
                      {displayPath(project.path)}
                    </span>
                    {project.linearFilter && (
                      <span className="flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
                        <span className="truncate">
                          Issues open on {describeFilter(project.linearFilter)}
                          {choosing &&
                            ` in ${workspaceName(workspaces, project.linearFilter.workspace)}`}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Clear ${project.name}'s issue filter`}
                          onClick={() => onClearProjectFilter(project.path)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X />
                        </Button>
                      </span>
                    )}
                  </div>
                  {choosing && (
                    <WorkspaceMenu
                      workspaces={workspaces}
                      value={project.linearWorkspace ?? null}
                      inherit={inheritLabel}
                      onChange={(next) => onSetProjectWorkspace(project.path, next)}
                    />
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

/// A saved filter in words: "Mobile · iOS, Android".
function describeFilter(filter: LinearFilter): string {
  const team = filter.teamId ? (filter.teamName ?? "a team") : null;
  const labels = filter.labels.join(", ");
  return [team, labels].filter(Boolean).join(" · ");
}

function WorkspaceRow({
  workspace,
  isDefault,
  canMakeDefault,
  confirming,
  busy,
  onAsk,
  onCancel,
  onDisconnect,
  onMakeDefault,
}: {
  workspace: TrackerAccount;
  isDefault: boolean;
  canMakeDefault: boolean;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onMakeDefault: () => void;
}) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-ui font-medium">
          {workspace.orgName}
          {isDefault && <span className="ml-2 font-normal text-muted-foreground">Default</span>}
        </span>
        <span className="truncate text-ui text-muted-foreground">
          {confirming
            ? "Dray will forget this key and every pin to it. Sessions keep their issues."
            : workspace.userName
              ? `as ${workspace.userName}`
              : "Linear has not answered for this key. Disconnect it, then add a new one."}
        </span>
      </div>

      {confirming ? (
        <CancelOrConfirm
          verb="Disconnect"
          busy={busy}
          onCancel={onCancel}
          onConfirm={onDisconnect}
        />
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {canMakeDefault && (
            <Button
              variant="ghost"
              size="sm"
              className="text-ui"
              disabled={busy}
              onClick={onMakeDefault}
            >
              Make default
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onAsk}>
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}

/// A pin: the inherited answer first, named, then every workspace.
function WorkspaceMenu({
  workspaces,
  value,
  inherit,
  onChange,
}: {
  workspaces: TrackerAccount[];
  value: string | null;
  inherit: string;
  onChange: (next: string | null) => void;
}) {
  // A pin to a workspace since disconnected reads as no pin, which is what Rust
  // does with it too.
  const pinned = value && workspaces.some((w) => w.workspaceId === value) ? value : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-56 shrink-0 gap-1 px-2 text-ui">
          <span className="truncate">{pinned ? workspaceName(workspaces, pinned) : inherit}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          // No pin rides on the empty string, which no workspace id can be.
          value={pinned ?? ""}
          onValueChange={(next) => onChange(next === "" ? null : next)}
        >
          <DropdownMenuRadioItem value="" className="text-ui">
            {inherit}
          </DropdownMenuRadioItem>
          {workspaces.map(
            (workspace) =>
              workspace.workspaceId && (
                <DropdownMenuRadioItem
                  key={workspace.workspaceId}
                  value={workspace.workspaceId}
                  className="text-ui"
                >
                  <span className="truncate">{workspace.orgName}</span>
                </DropdownMenuRadioItem>
              ),
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

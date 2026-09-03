import { useEffect, useRef, useState } from "react";
import { ChevronDown, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { displayPath } from "@/lib/space";
import type { Project } from "@/types/events";

/// Where spaces are made and projects filed into them.
///
/// Two lists, and the split is what each one is *for*: the spaces list is where
/// a space is made, renamed or removed, and the projects list files a project
/// into one that already exists. Spaces lead, since a project cannot be filed
/// before there is somewhere to file it.
///
/// The projects list draws every attached project whatever space is up, since a
/// list narrowed by the active space would hide exactly the rows somebody opens
/// this to move.
export default function SpacesSettings({
  projects,
  spaces,
  startNaming = false,
  onSetProjectSpace,
  onRemoveProject,
  onCreateSpace,
  onRenameSpace,
  onRemoveSpace,
}: {
  projects: Project[];
  spaces: string[];
  /// Opens with the new-space field already up. The sidebar's own "New space"
  /// lands here, and it would otherwise leave the reader on a tab to find the
  /// button they just pressed.
  startNaming?: boolean;
  onSetProjectSpace: (path: string, space: string | null) => void;
  onRemoveProject: (path: string) => void;
  onCreateSpace: (name: string) => void;
  onRenameSpace: (from: string, to: string) => void;
  onRemoveSpace: (name: string) => void;
}) {
  // The space being named — `""` for a new one, an existing name for a rename.
  // One at a time and held here rather than per row, so opening a second closes
  // the first instead of leaving two half-typed names on screen.
  const [naming, setNaming] = useState<string | null>(startNaming ? "" : null);
  // Which space has been asked about. Removal takes projects out of a space, so
  // it asks first — in the row, since a modal takes the whole window over
  // something that costs one dropdown to put back.
  const [confirming, setConfirming] = useState<string | null>(null);
  // The same question for the other list. Its own state, so asking about a
  // project cannot leave a space's row half-asked behind it.
  const [detaching, setDetaching] = useState<string | null>(null);

  const commit = (previous: string, value: string) => {
    const name = value.trim();
    setNaming(null);
    if (!name || name === previous) return;
    if (previous) onRenameSpace(previous, name);
    else onCreateSpace(name);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-ui font-medium text-muted-foreground">Spaces</h2>
          {/* On the heading's own row: it acts on the list under it, and a
              button at the bottom of a list that grows moves every time one is
              added. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirming(null);
              setNaming("");
            }}
            className="h-7 gap-1 px-2 text-ui text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3.5" />
            New space
          </Button>
        </div>

        <p className="text-ui text-muted-foreground">
          Switching space in the sidebar shows that set of projects alone.
          Everything else keeps running, out of sight and quiet.
        </p>

        {naming === "" && (
          <SpaceNameField
            label="New space"
            initial=""
            action="Create"
            onCommit={(value) => commit("", value)}
            onCancel={() => setNaming(null)}
          />
        )}

        {spaces.length === 0 && naming === null && (
          <p className="text-ui text-muted-foreground">No spaces yet.</p>
        )}

        {spaces.map((name) =>
          naming === name ? (
            <SpaceNameField
              key={name}
              label={`Rename ${name}`}
              initial={name}
              action="Save"
              onCommit={(value) => commit(name, value)}
              onCancel={() => setNaming(null)}
            />
          ) : (
            <div key={name} className="flex h-7 items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-ui">{name}</span>

              {confirming === name ? (
                // Confirm-and-X, the same shape a downloaded model is deleted
                // with: two controls where two sat before, so the row answers
                // in place instead of a sentence shoving the name sideways.
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="xs"
                    variant="destructive"
                    aria-label={`Remove ${name}`}
                    onClick={() => {
                      setConfirming(null);
                      onRemoveSpace(name);
                    }}
                  >
                    Confirm
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Keep ${name}`}
                    onClick={() => setConfirming(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X />
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-0.5">
                  {/* Renaming is a button, not the name itself: a label that
                      turns into a field when clicked is a control nothing says
                      is one, and the row already carries one real button. */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Rename ${name}`}
                    onClick={() => {
                      setConfirming(null);
                      setNaming(name);
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${name}`}
                    onClick={() => setConfirming(name)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-ui font-medium text-muted-foreground">Projects</h2>

        {projects.length === 0 ? (
          <p className="text-ui text-muted-foreground">
            No projects attached yet. Attach one from the composer, then file it
            into a space here.
          </p>
        ) : (
          projects.map((project) => (
            <div key={project.path} className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-ui font-medium">{project.name}</span>
                {/* Two projects can share a folder name, so the path is drawn
                    rather than hovered for — a native tooltip appears a second
                    late, in the OS's own type, over the row below it. */}
                <span className="truncate text-ui text-muted-foreground">
                  {displayPath(project.path)}
                </span>
              </div>

              {/* The question takes the row's controls over, picker included:
                  offering to file a project into a space while asking whether
                  to keep the project at all is two answers wanted at once. */}
              {detaching === project.path ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="xs"
                    variant="destructive"
                    aria-label={`Remove ${project.name}`}
                    onClick={() => {
                      setDetaching(null);
                      onRemoveProject(project.path);
                    }}
                  >
                    Confirm
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Keep ${project.name}`}
                    onClick={() => setDetaching(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X />
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-0.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        // Hugs its label: a fixed width holds a column of air
                        // open beside "No space" to fit a name nobody has
                        // typed yet.
                        className="max-w-40 shrink-0 gap-1 px-2 text-ui"
                      >
                        <span className="truncate">{project.space ?? "No space"}</span>
                        <ChevronDown className="size-3 shrink-0 opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>

                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup
                        // No space rides on the empty string, which no space
                        // can be named — the same bargain the sidebar's
                        // switcher makes.
                        value={project.space ?? ""}
                        onValueChange={(next) =>
                          onSetProjectSpace(project.path, next === "" ? null : next)
                        }
                      >
                        <DropdownMenuRadioItem value="" className="text-ui">
                          No space
                        </DropdownMenuRadioItem>
                        {spaces.map((name) => (
                          <DropdownMenuRadioItem
                            key={name}
                            value={name}
                            className="text-ui"
                          >
                            <span className="truncate">{name}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${project.name}`}
                    onClick={() => setDetaching(project.path)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/// The one field a space is named in, new or renamed.
///
/// Full width, with its two answers under it. Nothing else ends it: Enter and
/// the button commit, Escape and Cancel drop it, and **losing focus does
/// neither** — reaching for anything else on the tab mid-name would otherwise
/// throw the name away without saying so.
function SpaceNameField({
  label,
  initial,
  action,
  onCommit,
  onCancel,
}: {
  label: string;
  initial: string;
  action: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);

  // `autoFocus` alone loses the race when the field arrives *with* the dialog:
  // Radix's focus scope focuses the dialog on open and the menu that opened it
  // hands focus back to its own trigger on close, both after this mounts. A
  // frame later both have finished and the caret can stay put.
  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    // One row: the field takes what the two answers leave, which is the shape
    // every other row on this tab already has.
    <div className="flex items-center gap-2">
      {/* The app's own field, not a hand-rolled one: height, fill and the focus
          ring are all it, so this cannot drift from every other input. */}
      <Input
        ref={field}
        autoFocus
        aria-label={label}
        placeholder="Space name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          onCommit(value);
        }}
        className="flex-1 text-ui"
      />
      {/* Default size, which is the field's own height — `sm` beside it left
          the two answers sitting a pixel proud of the box they answer for. */}
      <Button variant="ghost" onClick={onCancel} className="text-ui">
        Cancel
      </Button>
      {/* Disabled on an empty name rather than accepting one and dropping it,
          which reads as the button doing nothing. */}
      <Button disabled={!value.trim()} onClick={() => onCommit(value)} className="text-ui">
        {action}
      </Button>
    </div>
  );
}

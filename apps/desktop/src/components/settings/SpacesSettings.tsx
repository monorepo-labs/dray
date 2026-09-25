import { useEffect, useRef, useState } from "react";
import { ChevronDown, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";

import { ConfirmOrKeep } from "@/components/settings/InRowConfirm";
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
import { cn } from "@/lib/utils";
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
  onMoveSpace,
  onMoveProject,
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
  /// Steps a space one place. Order is the sidebar switcher's, which walks the
  /// list in the order it is drawn here.
  onMoveSpace: (name: string, delta: number) => void;
  /// Moves a project `delta` places. Order is the composer picker's and the
  /// sidebar filter's, a space drawing its own projects in the same relative
  /// order.
  onMoveProject: (path: string, delta: number) => Promise<void> | void;
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
  const spaceDrag = useDragReorder(spaces, onMoveSpace);
  const projectDrag = useDragReorder(projects, (p, delta) => onMoveProject(p.path, delta));

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
          Everything else keeps running, out of sight and quiet. Drag to
          reorder; the switcher steps through spaces in this order.
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

        <div ref={spaceDrag.list} className="flex flex-col gap-1">
        {spaceDrag.shown.map((name, i) =>
          naming === name ? (
            // Still a child of the list, and still moved aside by a drag
            // passing it, so the rows' measured places stay true.
            <div key={name} style={spaceDrag.row(i, "").style}>
              <SpaceNameField
                label={`Rename ${name}`}
                initial={name}
                action="Save"
                onCommit={(value) => commit(name, value)}
                onCancel={() => setNaming(null)}
              />
            </div>
          ) : (
            <div key={name} {...spaceDrag.row(i, "gap-3 py-1 pr-1 pl-1.5")}>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <Grip
                  label={`Reorder ${name}`}
                  onKeyDown={(e) => spaceDrag.onGripKey(e, i)}
                />
                <span className="min-w-0 flex-1 truncate text-ui">{name}</span>
              </div>

              {confirming === name ? (
                // Confirm-and-X, the same shape a downloaded model is deleted
                // with: two controls where two sat before, so the row answers
                // in place instead of a sentence shoving the name sideways.
                <ConfirmOrKeep
                  confirmLabel={`Remove ${name}`}
                  keepLabel={`Keep ${name}`}
                  onConfirm={() => {
                    setConfirming(null);
                    onRemoveSpace(name);
                  }}
                  onKeep={() => setConfirming(null)}
                />
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
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-ui font-medium text-muted-foreground">Projects</h2>

        {projects.length > 1 && (
          <p className="text-ui text-muted-foreground">
            Drag to reorder. The composer and the sidebar filter list projects
            in this order.
          </p>
        )}

        {projects.length === 0 ? (
          <p className="text-ui text-muted-foreground">
            No projects attached yet. Attach one from the composer, then file it
            into a space here.
          </p>
        ) : (
          <div ref={projectDrag.list} className="flex flex-col gap-1">
          {projectDrag.shown.map((project, i) => (
            <div key={project.path} {...projectDrag.row(i, "gap-4 py-2 pr-2 pl-1.5")}>
              <div className="flex min-w-0 items-center gap-1.5">
                <Grip
                  label={`Reorder ${project.name}`}
                  onKeyDown={(e) => projectDrag.onGripKey(e, i)}
                />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-ui font-medium">{project.name}</span>
                  {/* Two projects can share a folder name, so the path is drawn
                      rather than hovered for — a native tooltip appears a second
                      late, in the OS's own type, over the row below it. */}
                  <span className="truncate text-ui text-muted-foreground">
                    {displayPath(project.path)}
                  </span>
                </div>
              </div>

              {/* The question takes the row's controls over, picker included:
                  offering to file a project into a space while asking whether
                  to keep the project at all is two answers wanted at once. */}
              {detaching === project.path ? (
                <ConfirmOrKeep
                  confirmLabel={`Remove ${project.name}`}
                  keepLabel={`Keep ${project.name}`}
                  onConfirm={() => {
                    setDetaching(null);
                    onRemoveProject(project.path);
                  }}
                  onKeep={() => setDetaching(null)}
                />
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
          ))}
          </div>
        )}
      </div>
    </div>
  );
}

/// Drag-to-reorder for one list on this tab. The row follows the pointer and
/// the rows it passes slide aside by transform, so nothing re-lays out mid-drag
/// and the drop point is judged against where rows sat when the drag began.
/// One move is written on release, however far the row travelled.
///
/// Pointer events rather than HTML drag: Tauri takes the native drag for file
/// drops, so `dragstart` never reaches the page.
function useDragReorder<T>(
  items: T[],
  onMove: (item: T, delta: number) => Promise<void> | void,
) {
  // The order after a drop, held until the write answers so the rows do not
  // snap back for the frame it takes.
  const [order, setOrder] = useState<T[] | null>(null);
  // `from` and `to` index `shown`; `dy` is how far the pointer has travelled
  // and `step` how far a row moves to make room.
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number; step: number } | null>(
    null,
  );
  const list = useRef<HTMLDivElement>(null);
  // Read at release, to tell whether the list moved under the drag.
  const latest = useRef(items);
  latest.current = items;
  const shown = order ?? items;

  const start = (e: React.PointerEvent<HTMLElement>, from: number) => {
    // Not while the last drop is still being written: the move is a relative
    // delta, so one measured against an unconfirmed order lands wrong if that
    // write fails.
    if (e.button !== 0 || !list.current || order) return;
    // The row's own controls and fields answer their own presses.
    if ((e.target as Element).closest("button:not([data-grip]), input")) return;
    // Keeps the press from starting a text selection across the rows.
    e.preventDefault();
    const el = e.currentTarget;
    const startY = e.clientY;
    const before = shown;
    const rects = [...list.current.children].map((row) => row.getBoundingClientRect());
    const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 0;
    const step = rects[from].height + gap;
    const mids = rects.map((r) => r.top + r.height / 2);
    // Held inside the list, so the row cannot be dragged off into nothing.
    const minDy = rects[0].top - rects[from].top;
    const maxDy = rects[rects.length - 1].bottom - rects[from].bottom;
    let to = from;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("session-drag");
    setDrag({ from, to, dy: 0, step });

    const move = (ev: PointerEvent) => {
      const dy = Math.min(maxDy, Math.max(minDy, ev.clientY - startY));
      // The leading edge crossing a neighbour's middle is past the neighbour.
      // Judged on the edge rather than the row's own middle, which the clamp
      // stops exactly on the end rows' middles and so could never pass them.
      const top = rects[from].top + dy;
      const bottom = rects[from].bottom + dy;
      to = from;
      while (to < mids.length - 1 && bottom > mids[to + 1]) to++;
      while (to > 0 && top < mids[to - 1]) to--;
      setDrag({ from, to, dy, step });
    };

    const end = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.classList.remove("session-drag");
      setDrag(null);
      // A cancelled gesture (focus lost, the OS taking the pointer) is not a
      // drop, and a list that changed mid-drag no longer matches the indexes.
      if (ev.type !== "pointerup" || latest.current !== before || to === from) return;
      const next = [...before];
      next.splice(to, 0, ...next.splice(from, 1));
      setOrder(next);
      void Promise.resolve(onMove(before[from], to - from)).finally(() => setOrder(null));
    };

    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const offsetOf = (i: number) => {
    if (!drag) return 0;
    if (i === drag.from) return drag.dy;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -drag.step;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return drag.step;
    return 0;
  };

  /// Spread onto each row; `layout` is the row's own padding and gap.
  const row = (i: number, layout: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => start(e, i),
    style: { transform: `translateY(${offsetOf(i)}px)` },
    className: cn(
      "flex cursor-grab touch-none items-center justify-between rounded-lg border bg-linear-to-b hover:from-card/15 hover:to-card/30",
      layout,
      // Only the rows making room glide; the one in hand tracks the pointer
      // exactly. No transition outside a drag, or the drop would animate rows
      // back from where they were drawn.
      drag && drag.from !== i && "transition-transform duration-150 ease-out",
      // Filled most while held, or it draws its text over the rows it passes.
      drag?.from === i &&
        "relative z-10 from-card/40 to-card/70 shadow-(--shadow-button) hover:from-card/40 hover:to-card/70",
    ),
  });

  /// Arrow keys on a row's grip, so the keyboard reaches what a drag does.
  const onGripKey = (e: React.KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    if (i + delta >= 0 && i + delta < shown.length) void onMove(shown[i], delta);
  };

  return { list, shown, row, onGripKey };
}

/// The handle drawn at the start of a draggable row.
function Grip({
  label,
  onKeyDown,
}: {
  label: string;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <button
      type="button"
      data-grip
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex h-7 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <GripVertical className="size-3.5" />
    </button>
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

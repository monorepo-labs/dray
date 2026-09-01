import { X } from "lucide-react";

import FileIcon from "@/components/FileIcon";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/types/events";

/// What is pinned to the composer, drawn above the text it will be sent with.
///
/// Two presentations for two things that travel differently. An image goes down
/// the wire as pixels, so it is shown as pixels — a thumbnail is the only label
/// a screenshot has. Anything else is handed to the model as a path, so it gets
/// the row a path deserves: the type glyph, the name, and the size. Neither is a
/// "file preview" — a tile says *this is attached*, and opening it is the job of
/// the editor the user already has.
///
/// Both tiles are the same height so a mixed tray still reads as one row.
export default function AttachmentTray({
  attachments,
  onRemove,
  modelTakesImages = true,
}: {
  attachments: Attachment[];
  onRemove: (path: string) => void;
  /// Whether the picked model can be handed an image at all. Some pi models
  /// report `input: ["text"]` and mean it.
  modelTakesImages?: boolean;
}) {
  if (!attachments.length) return null;

  // Said, not enforced. The image is still sent, because the harness's own
  // refusal names what was wrong where a guess made here could not — and Dray's
  // copy of what a model accepts can be stale, or absent where the harness
  // picked the model itself. Removing the tile, or refusing the drop, would act
  // on that guess.
  const warn = !modelTakesImages && attachments.some((a) => a.preview);

  return (
    // Spacing from the composer is the caller's, which is the only side that
    // knows what sits below it.
    <ul className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <li
          key={attachment.path}
          // `group` so one hover lights the remove button on this tile alone.
          // Deliberately no `title`: the path is the one thing the reader
          // already knows — they picked the file a second ago — so a hover
          // tooltip is a system popup reporting back what they just did.
          className="group relative"
        >
          {attachment.preview ? (
            <img
              src={attachment.preview}
              alt={attachment.name}
              className="size-14 rounded-lg border border-hairline-strong bg-card object-cover"
            />
          ) : (
            <div className="flex h-14 max-w-56 items-center gap-2 rounded-lg border border-hairline-strong bg-card px-2.5">
              <FileIcon path={attachment.path} className="size-5" />

              {/* `min-w-0` so the name truncates instead of setting the tile's
                  floor and pushing the rest out of the box. */}
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-ui">{attachment.name}</span>
                {/* Hidden rather than deleted. A size is what a file manager
                    owes you before you open something; here the file is already
                    attached and the number changes no decision. Kept wired up
                    because the judgement is about the tile, not the figure. */}
                <span className="hidden text-ui text-muted-foreground/70">
                  {formatBytes(attachment.size)}
                </span>
              </div>
            </div>
          )}

          {/* Hidden until the tile is hovered or the button itself is focused,
              so a full tray isn't a row of X's — but it stays reachable by
              keyboard, which `opacity` alone (unlike `hidden`) preserves. */}
          <button
            type="button"
            onClick={() => onRemove(attachment.path)}
            aria-label={`Remove ${attachment.name}`}
            className={cn(
              "absolute -top-1.5 -right-1.5 rounded-full border border-border bg-secondary p-0.5 text-secondary-foreground opacity-0 transition-opacity",
              "group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none",
            )}
          >
            <X className="size-3" strokeWidth={2.5} />
          </button>
        </li>
      ))}

      {warn && (
        // Inside the list so it wraps with the tiles it is about, and full
        // width so it reads as a line under them rather than a tile of its own.
        <li className="w-full text-ui text-muted-foreground">
          This model takes text only — the image will be sent, and the provider
          may refuse it.
        </li>
      )}
    </ul>
  );
}

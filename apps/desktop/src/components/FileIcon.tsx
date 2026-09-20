import { fileIconSrc } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";

/// The Material file glyph for a path — a React mark on `.tsx`, the TS mark on
/// `.ts`, and so on down to a plain sheet for anything unrecognized.
///
/// These are full-colour brand marks, which is a deliberate exception to the
/// monochrome chrome around them: colour is the whole reason to prefer them over
/// one generic glyph, since it makes a file's type readable before its name is.
export default function FileIcon({ path, className }: { path: string; className?: string }) {
  return (
    <img
      src={fileIconSrc(path)}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("size-4 shrink-0", className)}
    />
  );
}

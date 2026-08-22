import { getIconForFilePath } from "vscode-material-icons";

import { cn } from "@/lib/utils";

/// The Material file glyph for a path — a React mark on `.tsx`, the TS mark on
/// `.ts`, and so on down to a plain sheet for anything unrecognized.
///
/// Served as a file rather than inlined: the set is ~900 SVGs keyed by name, so
/// bundling them would ship the whole theme to show a handful. Vite stages them
/// into `public/file-icons` (see vite.config.ts), and in a packaged app they are
/// local reads with no network in front of them.
///
/// These are full-colour brand marks, which is a deliberate exception to the
/// monochrome chrome around them: colour is the whole reason to prefer them over
/// one generic glyph, since it makes a file's type readable before its name is.
export default function FileIcon({ path, className }: { path: string; className?: string }) {
  const name = getIconForFilePath(path);

  return (
    <img
      src={`/file-icons/${name}.svg`}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("size-4 shrink-0", className)}
    />
  );
}

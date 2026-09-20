import { getIconForFilePath } from "vscode-material-icons";

/// Where the Material glyph for a path is served from.
///
/// Split out of [FileIcon] so the composer's chips can build the same `<img>`
/// imperatively — `renderInto` writes DOM rather than JSX, so it cannot mount a
/// component, and a second copy of this template is a second answer to "which
/// icon is this file" the day the staging directory moves.
///
/// Staged into `public/file-icons` by vite.config.ts rather than bundled: the
/// set is ~900 SVGs keyed by name, so inlining them would ship the whole theme
/// to draw a handful.
///
/// [FileIcon]: ../components/FileIcon.tsx
export function fileIconSrc(path: string): string {
  return `/file-icons/${getIconForFilePath(path)}.svg`;
}

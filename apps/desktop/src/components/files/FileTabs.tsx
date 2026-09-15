import { X } from "lucide-react";

import FileIcon from "@/components/FileIcon";
import { tabLabels } from "@/lib/fileTree";
import { cn } from "@/lib/utils";
import type { OpenFile } from "@/hooks/useOpenFiles";

/// The open files as an editor's tab strip.
///
/// Overflow scrolls sideways and there is no dropdown: a strip long enough to
/// need one is a strip the reader should be closing tabs out of, and the tree
/// beside it reopens any of them in a click.
export default function FileTabs({
  files,
  active,
  onSelect,
  onClose,
}: {
  files: readonly OpenFile[];
  active: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const labels = tabLabels(files.map((file) => file.path));

  return (
    <div className="scrollbar-none flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
      {files.map((file, i) => (
        <Tab
          key={file.path}
          path={file.path}
          label={labels[i]}
          active={file.path === active}
          onSelect={() => onSelect(file.path)}
          onClose={() => onClose(file.path)}
        />
      ))}
    </div>
  );
}

function Tab({
  path,
  label,
  active,
  onSelect,
  onClose,
}: {
  path: string;
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    // A div rather than a button, because the close control sits inside it and
    // a button inside a button is invalid markup with a click that lands on the
    // wrong one — the same reading `FileLink` takes about the tool row.
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect();
      }}
      // Middle-click closes, the way it does in every editor this row is copied
      // from. `auxClick` rather than `mouseDown`, or a click begun on one tab
      // and released on another closes the wrong one.
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        onClose();
      }}
      title={path}
      className={cn(
        "group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-ui transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <FileIcon path={path} className="size-3.5" />
      <span className="max-w-40 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={(e) => {
          // Or closing a background tab would select it on the way out.
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          "rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground",
          // Always on the active tab, on hover elsewhere: a row of crosses is
          // a row of things to press by accident, and the tab being read is
          // the one whose close is worth reaching for without hunting.
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" strokeWidth={2} />
      </button>
    </div>
  );
}

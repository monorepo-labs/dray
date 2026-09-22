import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, SquareDashedMousePointer } from "lucide-react";

import { cx } from "./Window";

/// The browser pane's chrome: the tab strip and the toolbar under it, as
/// `BrowserPane` draws them. The page goes in `children`.
export function BrowserChrome({
  tab,
  url,
  picking = false,
  children,
  className,
}: {
  tab: ReactNode;
  url: ReactNode;
  picking?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex h-full min-h-0 flex-col bg-background", className)}>
      <div className="shrink-0 border-b border-border">
        <div className="flex h-8 items-end gap-1 bg-sidebar px-2.5 pt-1">
          <div className="flex h-7 w-40 min-w-0 shrink-0 items-center gap-1.5 rounded-t-md bg-card px-2 text-ui text-foreground">
            <Globe className="size-3.5 shrink-0 opacity-60" />
            <span className="min-w-0 flex-1 truncate">{tab}</span>
          </div>
          <span className="mb-0.5 grid size-7 shrink-0 place-items-center text-muted-foreground">
            <Plus className="size-3.5" />
          </span>
        </div>
        <div className="flex h-9 items-center gap-0.5 bg-card px-1.5 text-muted-foreground">
          <ToolButton>
            <ArrowLeft className="size-3.5" />
          </ToolButton>
          <ToolButton>
            <ArrowRight className="size-3.5" />
          </ToolButton>
          <ToolButton>
            <RotateCw className="size-3.5" />
          </ToolButton>
          <div className="relative min-w-0 flex-1">
            <div className="flex h-7 w-full items-center rounded-md bg-background px-2.5 font-mono text-ui text-foreground">
              {url}
            </div>
          </div>
          <ToolButton className={cx(picking && "bg-primary/15 text-primary")}>
            <SquareDashedMousePointer className="size-3.5" />
          </ToolButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function ToolButton({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", className)}>
      {children}
    </span>
  );
}

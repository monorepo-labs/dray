"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { INSTALL_LINE } from "@/lib/links";

/// The server install as a line to copy. The line scrolls rather than wraps on
/// a phone: a shell command broken over two lines reads as two commands. Its
/// bar is hidden, since the copy button is how anybody takes the whole line.
export function InstallLine({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-border py-1.5 pr-1.5 pl-4 font-mono text-sm ${className ?? ""}`}
    >
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-foreground [scrollbar-width:none]">
        <span className="text-muted-foreground select-none">$ </span>
        {INSTALL_LINE}
      </code>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy install command"}
        onClick={() => {
          void navigator.clipboard.writeText(INSTALL_LINE).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

import { Search } from "lucide-react";

import ShortcutKeys from "@/components/ShortcutKeys";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { useHotkey } from "@/hooks/useHotkey";

/// A list page's search field: the issues page's and the pull requests
/// page's, one control so the two need no learning twice.
///
/// ⌘⇧F reaches it while `active`, through the `issues.search` binding — the
/// two pages are never on screen together, so one chord serves both. Bound
/// here rather than in `App`, unlike ⌘F: `enabled` unregisters the listener
/// outright, and `useHotkey` calls `preventDefault` on every match, so a
/// binding left standing would eat ⌘⇧F from whatever *is* on screen.
/// `select` rather than `focus`, so pressing it on a query replaces it.
///
/// **Shifted, where the sidebar's is not.** ⌘F belongs to the sidebar and is
/// bound app-wide, so a second field claiming it would take the one search
/// that works from anywhere and make it depend on which view is up.
export default function PageSearch({
  id,
  active,
  value,
  onChange,
  placeholder,
}: {
  /// What ⌘⇧F finds the field by.
  id: string;
  active: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  useHotkey("issues.search", () => document.querySelector<HTMLInputElement>(`#${id}`)?.select(), {
    enabled: active,
  });

  return (
    // No fill and no border. A search box is the one control here that is
    // always in the same place, so it needs no edge to be found — and a filled
    // field above a borderless list draws a box round the least interesting
    // third of the page. The glyph does the work the border was doing.
    <div className="group flex h-11 shrink-0 items-center gap-2 px-3">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        // `dark:bg-transparent` as well as `bg-transparent`: the base input
        // carries `dark:bg-input/30`, which is the more specific rule and
        // wins — so the plain override read as removed while leaving a fill.
        className="h-full rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        onChange={(e) => onChange(e.currentTarget.value)}
        // Escape drops the query, the sidebar's rule. It does *not* blur: the
        // field is always drawn, so there is nothing to close and a caret left
        // where it was is a second search ready to be typed.
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !value) return;
          e.preventDefault();
          onChange("");
        }}
      />

      {/* The slot names whichever key does something here, and which one
          that is turns on focus alone — the sidebar's rule. Esc is withheld
          over an empty field, the one state neither key has anything to do. */}
      {value && <Kbd className="hidden group-focus-within:inline-flex">Esc</Kbd>}
      <ShortcutKeys ids={["issues.search"]} className="group-focus-within:hidden" />
    </div>
  );
}

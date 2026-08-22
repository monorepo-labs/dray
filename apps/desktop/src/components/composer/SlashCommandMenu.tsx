import PickerMenu, { type PickerGroup } from "@/components/composer/PickerMenu";
import type { SlashCommand } from "@/types/events";

/// The `/` picker's rows. Everything else about the list — where it opens, how
/// it scrolls, how a row lights up — is [PickerMenu]'s, which the `@` picker
/// shares.
///
/// [PickerMenu]: ./PickerMenu.tsx
export default function SlashCommandMenu({
  groups,
  activeIndex,
  onPick,
  onHover,
  placement = "above",
  bare = false,
}: {
  groups: PickerGroup<SlashCommand>[];
  activeIndex: number;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  placement?: "above" | "below";
  bare?: boolean;
}) {
  return (
    <PickerMenu
      groups={groups}
      label="Slash commands"
      keyOf={(command) => command.name}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      placement={placement}
      bare={bare}
      renderItem={(command) => (
        <>
          <span className="shrink-0 font-medium">/{command.name}</span>

          {command.argumentHint && (
            <span className="shrink-0 text-muted-foreground/60">{command.argumentHint}</span>
          )}

          {/* Descriptions run to a paragraph on skill-backed commands, so this
              is one line that gives way to the name rather than wrapping the row
              to three. */}
          {command.description && (
            <span className="min-w-0 truncate text-muted-foreground">{command.description}</span>
          )}
        </>
      )}
    />
  );
}

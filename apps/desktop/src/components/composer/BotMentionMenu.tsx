import BotAvatar from "@/components/BotAvatar";
import PickerMenu from "@/components/composer/PickerMenu";
import type { Bot } from "@/types/events";

/// The `@` picker's rows in a bot's chat, where `@` names the other bots rather
/// than files: the bot's folder holds its notes, which nobody mentions.
export default function BotMentionMenu({
  bots,
  activeIndex,
  onPick,
  onHover,
  emptyNote,
  bare = false,
}: {
  bots: Bot[];
  activeIndex: number;
  onPick: (bot: Bot) => void;
  onHover: (index: number) => void;
  emptyNote?: string;
  bare?: boolean;
}) {
  return (
    <PickerMenu
      groups={[{ label: null, items: bots }]}
      label="Bots"
      keyOf={(bot) => bot.id}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      bare={bare}
      emptyNote={emptyNote}
      renderItem={(bot) => (
        <>
          <BotAvatar seed={bot.id} avatar={bot.avatar} className="size-4" />
          <span className="min-w-0 truncate">{bot.name}</span>
        </>
      )}
    />
  );
}

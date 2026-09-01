import { Check, Mic, X } from "lucide-react";

import Orb from "@/components/Orb";
import AudioVisualizer from "@/components/composer/AudioVisualizer";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RecorderState } from "@/hooks/useTranscription";
import { cn } from "@/lib/utils";

/// The controls are 28px (`icon-sm`), so every state of this component is too.
///
/// Transcribing draws no button at all, and without a floor the row collapses
/// to the height of a line of text the moment the model starts — the composer
/// jumps, then jumps back a second later. Matching the button height means the
/// row is the same size in all three states and nothing moves.
const ROW_H = "h-7";

/// Dictation, in whichever of its three shapes applies.
///
/// Idle is one button. Recording is three controls — the level, a cancel, and a
/// stop — because stopping and cancelling mean opposite things about the words
/// just spoken and must never be the same press. Handy can get away with one
/// key for both because it types into whatever window has focus; here the
/// transcript lands in a draft the reader can see, so throwing it away has to
/// be deliberate.
export default function DictateControl({
  state,
  level,
  onStart,
  onStop,
  onCancel,
}: {
  state: RecorderState;
  level: number;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  if (state === "transcribing") {
    return (
      // The orb alone, no label. "Transcribing" was here and lasted about as
      // long as it took to read — on a short phrase the model answers in well
      // under a second, so the word appeared and vanished as a flash. The orb
      // says the same thing without asking to be read.
      //
      // Boxed to the button's own 28px so swapping in and out of this state
      // moves nothing, and *scaled* to fill it: `OrbSize` is 20 or 64 and
      // nothing between, so the 28px this row wants can only be reached by
      // drawing the 20 and transforming it. A transform rather than a width,
      // since the orb sizes its own canvas from the prop.
      <div
        className={cn("flex w-7 items-center justify-center", ROW_H)}
        aria-label="Transcribing"
        aria-live="polite"
      >
        <Orb state="solving" size={20} aria-hidden style={{ transform: "scale(1.4)" }} />
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div className={cn("flex items-center gap-1", ROW_H)}>
        {/* Between the two buttons rather than beside them, so the thing being
            acted on sits inside the controls that act on it. */}
        {/* `text-foreground`, so the bars follow the theme and the mode like
            everything else. They were `text-destructive`, which read as an
            error rather than as a live level — red is what this palette says
            "something is wrong" with, and a working microphone is not that. */}
        <AudioVisualizer level={level} className="px-1 text-foreground" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onCancel}
              aria-label="Discard recording"
              className="rounded-full text-muted-foreground"
            >
              <X strokeWidth={2} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Discard
            <KbdGroup>
              <Kbd>esc</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            {/* Filled, where cancel is a ghost: of the two, this is the one the
                press was for, and the tick says the words are kept. */}
            <Button
              type="button"
              size="icon-sm"
              onClick={onStop}
              aria-label="Stop and transcribe"
              className="rounded-full"
            >
              <Check strokeWidth={2.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Stop and transcribe
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>D</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onStart}
          aria-label="Dictate"
          className="rounded-full text-muted-foreground"
        >
          <Mic />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        Dictate
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>D</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}

import { Check, FolderOpen, Mic, RotateCcw, X } from "lucide-react";

import AudioVisualizer from "@/components/composer/AudioVisualizer";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RecorderState } from "@/hooks/useTranscription";
import { cn } from "@/lib/utils";

/// The controls are 28px (`icon-sm`), so every state of this component is too.
///
/// Stated rather than inherited, since transcribing draws a `span` where the
/// other two states draw buttons — without a floor the row would collapse to
/// the height of a line of text the moment the model starts, so the composer
/// jumps and then jumps back a second later.
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
  savedAudio,
  onStart,
  onStop,
  onCancel,
  onRetry,
  onReveal,
}: {
  state: RecorderState;
  level: number;
  /// Where a run that could not answer left the audio, or `null` where the last
  /// one landed. Its presence is the whole condition for the retry pair — the
  /// backend only hands a path back when there is a file behind it.
  savedAudio: string | null;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onReveal: () => void;
}) {
  if (state === "transcribing") {
    return (
      // The stop button again, with the tick swapped for a spinner. Recording's
      // rightmost control is where the press just landed, so keeping the same
      // filled circle in the same place says the app is working on what was
      // asked rather than that the control went away.
      //
      // A `span` carrying the button's own classes, not a disabled `Button`:
      // there is nothing to press, and `disabled` would dim the fill to half
      // for a state that lasts under a second — a flicker, not information.
      //
      // `pointer-events-none` is what takes the hover and press states back off
      // it. Those ride along with the fill, and a shape that lightens under the
      // cursor is promising a click that does nothing.
      <span
        className={cn(
          buttonVariants({ size: "icon-sm" }),
          "pointer-events-none rounded-full",
          ROW_H,
        )}
        role="status"
        aria-label="Transcribing"
        aria-live="polite"
      >
        <Spinner />
      </span>
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

  const mic = (
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

  if (!savedAudio) return mic;

  // A run that could not answer left the audio on disk, so the words are still
  // recoverable and the offer to recover them belongs here — beside the control
  // that produced them, not in the error line above, which is shared with git
  // and the CLI and says what happened rather than what can be done about it.
  //
  // The mic keeps its place at the end: talking again is still the primary
  // action, and pressing it is what retires this pair.
  return (
    <div className={cn("flex items-center gap-1", ROW_H)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onReveal}
            aria-label="Show the recording"
            className="rounded-full text-muted-foreground"
          >
            <FolderOpen strokeWidth={2} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Show the recording</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          {/* Filled, like the stop it stands in for: of the controls on this
              row it is the one carrying the press the reader already made. */}
          <Button
            type="button"
            size="icon-sm"
            onClick={onRetry}
            aria-label="Transcribe the recording again"
            className="rounded-full"
          >
            <RotateCcw strokeWidth={2.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Transcribe again</TooltipContent>
      </Tooltip>

      {mic}
    </div>
  );
}

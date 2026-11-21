import { Check, FolderOpen, RotateCcw, X } from "lucide-react";

import VoiceOrb from "@/components/composer/VoiceOrb";
import { Button } from "@/components/ui/button";
import ShortcutKeys from "@/components/ShortcutKeys";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RecorderState } from "@/hooks/useTranscription";

/// The voice orb at the input's left edge: pressed to talk, pressed again to
/// stop, as on the iPhone. It is the level while recording and the spinner
/// while transcribing, so those need no control of their own.
export function DictateOrb({
  state,
  level,
  onStart,
  onStop,
}: {
  state: RecorderState;
  level: number;
  onStart: () => void;
  onStop: () => void;
}) {
  const label = state === "idle" ? "Dictate" : state === "recording" ? "Stop and transcribe" : "Transcribing";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* `aria-disabled` rather than `disabled` while transcribing, so the
            tooltip still opens to say what the orb is doing. */}
        <button
          type="button"
          onClick={state === "idle" ? onStart : state === "recording" ? onStop : undefined}
          aria-label={label}
          aria-disabled={state === "transcribing"}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-default aria-disabled:hover:scale-100"
        >
          <VoiceOrb size={24} level={level} state={state} className="shadow-sm" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {state !== "transcribing" && <ShortcutKeys ids={["dictate"]} />}
      </TooltipContent>
    </Tooltip>
  );
}

/// What dictation puts beside Send: while recording a cancel and a stop, and
/// after a run that could not answer, the pair that recovers its audio.
///
/// Recording keeps two buttons because stopping and cancelling mean opposite
/// things about the words just spoken and must never be the same press. Handy
/// can get away with one key for both because it types into whatever window has
/// focus; here the transcript lands in a draft the reader can see, so throwing
/// it away has to be deliberate.
export default function DictateControl({
  state,
  savedAudio,
  onStop,
  onCancel,
  onRetry,
  onReveal,
}: {
  state: RecorderState;
  /// Where a run that could not answer left the audio, or `null` where the last
  /// one landed. Its presence is the whole condition for the retry pair — the
  /// backend only hands a path back when there is a file behind it.
  savedAudio: string | null;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onReveal: () => void;
}) {
  if (state === "transcribing") return null;

  if (state === "recording") {
    return (
      <div className="flex h-7 items-center gap-1">
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
            <ShortcutKeys ids={["dictate"]} />
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (!savedAudio) return null;

  // A run that could not answer left the audio on disk, so the words are still
  // recoverable and the offer to recover them belongs here — beside the
  // controls, not in the error line above, which is shared with git and the CLI
  // and says what happened rather than what can be done about it. Talking again
  // is still the orb, and pressing it is what retires this pair.
  return (
    <div className="flex h-7 items-center gap-1">
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
    </div>
  );
}

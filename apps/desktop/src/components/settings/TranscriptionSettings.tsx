import { useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronDown, Download, ExternalLink, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Downloads } from "@/hooks/useTranscription";
import { cn } from "@/lib/utils";
import type { TranscriptionModel, TranscriptionStatus } from "@/types/events";

/// Sizes here are hundreds of megabytes, so the unit is GB past 1000MB — "1187
/// MB" is a number the reader has to convert themselves before it means
/// anything about their disk.
function formatSize(bytes: number): string {
  const mb = bytes / 1e6;

  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/// The system default is a real choice, not the absence of one, so it is an
/// entry in the menu rather than the state of having picked nothing.
const SYSTEM_DEFAULT = "__default__";


/// One of the two model scores, as a labelled bar.
///
/// A bar rather than the number, because a number invites a precision that is
/// not there: these are Handy's relative catalog scores, not a measured word
/// error rate or a real-time factor. A bar answers the question the reader
/// actually has, which is which of two models to pick.
function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5" title={`${label} ${value} of 100`}>
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span
        role="meter"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        // `--muted` is a couple of percent off the card it sits on, which at
        // 4px tall left the empty part of the bar invisible — so a low score
        // read as a short stray mark rather than as a bar that is mostly
        // unfilled. A share of the foreground instead, which separates from the
        // surface in both modes by construction.
        className="h-1 w-12 overflow-hidden rounded-full bg-foreground/20"
      >
        {/* `--accent-add` is the app's one green — the same token the diff's
            added lines, an open PR and an unread session use, so this reads as
            "good" in the palette's own vocabulary rather than as a fourth
            literal. Dark takes the foreground instead — the green is tuned for
            contrast against a light page and goes muddy on a dark one — held
            just off full, since a pure white bar out-shouts the model name
            above it. */}
        <span
          className="block h-full rounded-full bg-accent-add dark:bg-foreground/90"
          style={{ width: `${value}%` }}
        />
      </span>
    </span>
  );
}

/// One model: what it is, how big, and the one action available on it.
///
/// Downloaded models are selectable and deletable; the rest offer a download.
/// The three states are exclusive by construction — a model cannot be
/// downloading and installed — which is what keeps the row to a single button.
function ModelRow({
  model,
  installed,
  selected,
  recommended,
  progress,
  confirming,
  onSelect,
  onDownload,
  onCancelDownload,
  onAskDelete,
  onDelete,
  onKeepIt,
}: {
  model: TranscriptionModel;
  installed: boolean;
  selected: boolean;
  recommended: boolean;
  progress?: { received: number; total: number };
  /// The bin has been pressed and the row is waiting to be told twice.
  confirming: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancelDownload: () => void;
  onAskDelete: () => void;
  onDelete: () => void;
  onKeepIt: () => void;
}) {
  const downloading = progress !== undefined;
  const percent = progress ? Math.round((progress.received / progress.total) * 100) : 0;

  // Only a downloaded model can be picked, so only then is the row a control.
  // A row that looks clickable and answers nothing is worse than a plain one,
  // and downloading several hundred megabytes is too big a thing to trigger by
  // clicking a row — that keeps its own button.
  const pickable = installed && !selected;

  // The catalog writes the phrase two ways on purpose — named where they fit,
  // counted where they don't — and only the counted one leaves a question open.
  const counted = /^\d+ languages$/.test(model.languages);

  return (
    <div
      role={installed ? "radio" : undefined}
      aria-checked={installed ? selected : undefined}
      tabIndex={pickable ? 0 : undefined}
      onClick={pickable ? onSelect : undefined}
      onKeyDown={
        pickable
          ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelect();
            }
          : undefined
      }
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected ? "border-ring bg-muted/40" : "border-border",
        pickable && "cursor-pointer hover:bg-muted/30",
      )}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {selected && <Check className="size-4 shrink-0" aria-hidden />}
          <span className="text-ui font-medium">{model.name}</span>
          {recommended && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Recommended
            </span>
          )}
        </div>
        <p className="text-ui text-muted-foreground">{model.description}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-ui text-muted-foreground">
          {/* Languages first: it decides whether the model is usable at all,
              where the size only decides what it costs. A reader who needs
              German is done reading at the first word.

              A count raises the question a name already answers — *which* 28?
              — so only a count links out, at the model's own page rather than
              expanding a list this row would have to hold. "English, German,
              Spanish, French" has nowhere left to send anybody. */}
          {counted ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openUrl(`https://huggingface.co/${model.repo}`);
              }}
              className="inline-flex cursor-pointer items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {model.languages}
              <ExternalLink className="size-3" aria-hidden />
            </button>
          ) : (
            <span>{model.languages}</span>
          )}
          <span aria-hidden>·</span>
          <span>{formatSize(model.sizeBytes)}</span>
        </p>
      </div>

      {/* Actions ride the bar row rather than the title's, which is what lets
          the confirmation sit in the flow instead of floating over the bin.
          Beside the title they shared a line with prose that had to give up
          width for them, so anything wider than an icon re-wrapped the
          description and moved every row below; the bars are fixed-width and
          give up nothing, so the buttons can grow into the gap between. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ScoreBar label="Speed" value={model.speed} />
          <ScoreBar label="Accuracy" value={model.accuracy} />
        </div>

        {/* Every button here sits inside the row's own click target, so the
            group stops the event — otherwise deleting a model would select it
            on the way down. */}
        <div
          className="flex shrink-0 items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {downloading ? (
            <>
              {/* The bar underneath is the progress indicator; a spinner beside
                  a percentage that is already moving says the same thing twice. */}
              <span className="text-ui tabular-nums text-muted-foreground">{percent}%</span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={onCancelDownload}
                aria-label={`Cancel downloading ${model.name}`}
                className="cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <X />
              </Button>
            </>
          ) : installed && confirming ? (
            // Asked in the row rather than in a dialog, which would take the
            // whole window over a file Download gets back.
            <>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={onDelete}
                aria-label={`Delete ${model.name}`}
                className="cursor-pointer"
              >
                Confirm
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={onKeepIt}
                aria-label={`Keep ${model.name}`}
                className="cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <X />
              </Button>
            </>
          ) : installed ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onAskDelete}
              aria-label={`Delete ${model.name}`}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <Trash2 />
            </Button>
          ) : (
            // Icon alone. The word said what the arrow already says.
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onDownload}
              aria-label={`Download ${model.name}`}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <Download />
            </Button>
          )}
        </div>
      </div>

      {/* Only while downloading, and driven by the same numbers as the
          percentage beside it, so the two cannot disagree. */}
      {downloading && (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/20">
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

/// Models and microphone, the two things transcription needs before it works.
///
/// Nothing ships downloaded. The list is the whole first-run experience: the
/// mic button in the composer sends the reader here rather than pulling
/// hundreds of megabytes on a press meant to start talking.
export default function TranscriptionSettings({
  status,
  downloads,
  onDownload,
  onCancelDownload,
  onDelete,
  onSelectModel,
  onSelectDevice,
  onSetMute,
}: {
  status: TranscriptionStatus | null;
  downloads: Downloads;
  onDownload: (id: string) => void;
  onCancelDownload: (id: string) => void;
  onDelete: (id: string) => void;
  onSelectModel: (id: string) => void;
  onSelectDevice: (device: string | null) => void;
  onSetMute: (mute: boolean) => void;
}) {
  // One id, not a flag per row: two rows asking the question at once would be
  // two red buttons where only one press was ever made.
  const [confirming, setConfirming] = useState<string | null>(null);

  if (!status) {
    return (
      <p className="text-ui text-muted-foreground">Reading transcription settings…</p>
    );
  }

  const selectedDevice =
    status.devices.find((d) => d.name === status.selectedDevice)?.name ?? SYSTEM_DEFAULT;
  const deviceLabel =
    selectedDevice === SYSTEM_DEFAULT ? "System default" : selectedDevice;

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-ui font-medium text-muted-foreground">Model</h2>
          {/* The one thing worth saying here, and the reason the download is
              worth its size: nothing is sent anywhere. */}
          <p className="text-ui text-muted-foreground">
            Transcription runs on this Mac. Audio never leaves it.
          </p>
        </div>

        {/* The list is a single choice, so it says so — that is also what makes
            arrow keys move between rows rather than tab. */}
        <div role="radiogroup" aria-label="Transcription model" className="flex flex-col gap-2">
          {status.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              installed={status.installed.includes(model.id)}
              selected={status.selectedModel === model.id}
              recommended={status.recommended === model.id}
              progress={downloads[model.id]}
              confirming={confirming === model.id}
              // Picking a row closes any question open on another, so the red
              // button never outlives the reader's attention on it.
              onSelect={() => {
                setConfirming(null);
                onSelectModel(model.id);
              }}
              onDownload={() => onDownload(model.id)}
              onCancelDownload={() => onCancelDownload(model.id)}
              // Asks first. The file is hundreds of megabytes over somebody's
              // connection, the bin sits a few pixels from the row that
              // *selects* the model, and there is no undo — three reasons a
              // misread click must not be the whole action.
              onAskDelete={() => setConfirming(model.id)}
              onDelete={() => {
                setConfirming(null);
                onDelete(model.id);
              }}
              onKeepIt={() => setConfirming(null)}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-ui font-medium text-muted-foreground">Input</h2>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-4">
            <label className="text-ui font-medium" id="transcription-device">
              Microphone
            </label>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="max-w-56 cursor-pointer justify-between"
                >
                  <span className="truncate">{deviceLabel}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={selectedDevice}
                  onValueChange={(next) =>
                    onSelectDevice(next === SYSTEM_DEFAULT ? null : next)
                  }
                >
                  <DropdownMenuRadioItem value={SYSTEM_DEFAULT}>
                    System default
                  </DropdownMenuRadioItem>
                  {status.devices.map((device) => (
                    <DropdownMenuRadioItem key={device.name} value={device.name}>
                      {device.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {status.devices.length === 0 && (
            <p className="text-ui text-muted-foreground">No microphone was found.</p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-4">
            <label className="text-ui font-medium" htmlFor="transcription-mute">
              Mute while recording
            </label>

            <Switch
              id="transcription-mute"
              checked={status.muteWhileRecording}
              onCheckedChange={onSetMute}
            />
          </div>

          {/* Two sentences doing two jobs: why it is on by default, and that
              the machine is not left silent. Without the second the switch
              reads as something the reader has to undo themselves. */}
          <p className="text-ui text-muted-foreground">
            Keeps whatever is playing out of the transcript. Unmuted automatically when
            recording stops.
          </p>
        </div>
      </section>
    </div>
  );
}

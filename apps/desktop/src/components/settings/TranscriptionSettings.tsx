import { Check, Download, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  onSelect,
  onDownload,
  onCancelDownload,
  onDelete,
}: {
  model: TranscriptionModel;
  installed: boolean;
  selected: boolean;
  recommended: boolean;
  progress?: { received: number; total: number };
  onSelect: () => void;
  onDownload: () => void;
  onCancelDownload: () => void;
  onDelete: () => void;
}) {
  const downloading = progress !== undefined;
  const percent = progress ? Math.round((progress.received / progress.total) * 100) : 0;

  // Only a downloaded model can be picked, so only then is the row a control.
  // A row that looks clickable and answers nothing is worse than a plain one,
  // and downloading several hundred megabytes is too big a thing to trigger by
  // clicking a row — that keeps its own button.
  const pickable = installed && !selected;

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
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
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
          <p className="text-ui text-muted-foreground">
            {formatSize(model.sizeBytes)}
            {" · "}
            {model.languages}
          </p>
        </div>

        {/* Every button here sits inside the row's own click target, so each
            stops the event — otherwise deleting a model would select it on the
            way down. */}
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
          ) : installed ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onDelete}
              aria-label={`Delete ${model.name}`}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <Trash2 />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onDownload}
              className="cursor-pointer"
            >
              <Download />
              Download
            </Button>
          )}
        </div>
      </div>

      {/* Only while downloading, and driven by the same numbers as the
          percentage beside it, so the two cannot disagree. */}
      {downloading && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
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
}: {
  status: TranscriptionStatus | null;
  downloads: Downloads;
  onDownload: (id: string) => void;
  onCancelDownload: (id: string) => void;
  onDelete: (id: string) => void;
  onSelectModel: (id: string) => void;
  onSelectDevice: (device: string | null) => void;
}) {
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
              onSelect={() => onSelectModel(model.id)}
              onDownload={() => onDownload(model.id)}
              onCancelDownload={() => onCancelDownload(model.id)}
              onDelete={() => onDelete(model.id)}
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
                  className="max-w-56 cursor-pointer justify-start"
                >
                  <span className="truncate">{deviceLabel}</span>
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
      </section>
    </div>
  );
}

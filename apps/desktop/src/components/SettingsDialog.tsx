import { useId, useState, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import LinearIcon from "@/components/LinearIcon";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAppSettings } from "@/hooks/useAppSettings";
import type { useIntegrations } from "@/hooks/useIntegrations";
import type { SettingsView } from "@/types/events";

/// The app's preferences, such as they are.
///
/// Mounted in `App` rather than beside the gear that opens it: the sidebar
/// unmounts when it collapses, and a dialog living there would take the ⌘,
/// shortcut with it — which is the one route into this that survives a
/// collapsed sidebar.
export default function SettingsDialog({
  open,
  onOpenChange,
  integrations,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /// Owned by `App`, because the issues page and the composer read it too.
  integrations: ReturnType<typeof useIntegrations>;
}) {
  const { settings, setAnalyticsEnabled } = useAppSettings(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Each row carries its own sentence, so there is no one description the
          dialog is described *by* — left unset, Radix warns about the missing
          `aria-describedby` and pointing it at a row would read that row's copy
          out as the dialog's purpose. */}
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <IssueTrackerRow {...integrations} />

        <AnalyticsRow view={settings} onChange={setAnalyticsEnabled} />
      </DialogContent>
    </Dialog>
  );
}

/// Two sentences: what it is for, and what it never touches.
///
/// The second one is the row's whole job. "Analytics" reads as behavioural
/// tracking to most people, and for a tool that watches you work on your own
/// code, saying plainly that conversations and activity are not collected is
/// the part worth the space. Kept short on purpose — an itemised list of
/// fields reads as something to be wary of rather than something to skim.
function AnalyticsRow({
  view,
  onChange,
}: {
  view: SettingsView | null;
  onChange: (next: boolean) => void;
}) {
  const id = useId();

  return (
    <SettingRow
      id={id}
      label="Share basic analytics"
      description={
        view?.analyticsLocked
          ? // Disabled and saying why, rather than hidden or — worse — drawn
            // from the stored value and sitting at `on` while nothing is sent.
            "Turned off for this run by DRAY_NO_ANALYTICS."
          : "Counts how many people use Dray. Your conversations and activity are never collected."
      }
    >
      <Switch
        id={id}
        // `null` until the first read lands. Disabled rather than guessing a
        // value: either guess is wrong for somebody, and the dialog's own open
        // animation is longer than a local file read.
        disabled={view === null || view.analyticsLocked}
        checked={view?.analyticsEnabled ?? false}
        onCheckedChange={onChange}
      />
    </SettingRow>
  );
}

/// The connected issue tracker — and **only** when there is one.
///
/// Connecting happens on the issues page, not here. That page is the surface
/// with nothing to show without a key, so it is where the field that fixes it
/// belongs; a second copy in this dialog would be a second form for one slot,
/// and a settings row offering to connect something the reader has never seen
/// is a row they cannot judge. What is left here is what settings are actually
/// for: seeing what is connected, and taking it back.
function IssueTrackerRow({
  integrations,
  busy,
  error,
  disconnect,
}: ReturnType<typeof useIntegrations>) {
  const id = useId();
  /// The button arms a confirm that replaces it — the same shape the sidebar's
  /// delete and the PR panel's merge use. Asked for because the key is not
  /// recoverable from here: taking it back means finding the tracker's own
  /// settings page and minting a new one, which is a long way to be sent by a
  /// button pressed on the way to somewhere else.
  const [confirming, setConfirming] = useState(false);

  const account = integrations?.linear ?? null;

  // Nothing connected is nothing to say. The reader is not missing a control:
  // the Issues page in the sidebar is where this starts.
  if (!account) return null;

  return (
    <div className="flex flex-col gap-2">
      <SettingRow
        id={id}
        label="Issue tracker"
        description={
          confirming
            ? "Dray will forget the key. Sessions keep the issues they are tagged with."
            : // The mark rather than the word, since the word is already the row's
              // subject — and it is what makes this row findable at a glance in a
              // dialog of sentences.
              <span className="flex items-center gap-1.5">
                <LinearIcon className="size-3.5" />
                {account.orgName}, as {account.userName}
              </span>
        }
      >
        {confirming ? (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={async () => {
                await disconnect();
                setConfirming(false);
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </SettingRow>

      {error && <p className="text-ui text-destructive">{error}</p>}
    </div>
  );
}

/// Label and reason on the left, control on the right — the shape every
/// settings row here should take, so the second one costs no layout decisions.
function SettingRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  /// A node, not a string: a row whose reason is best said with a mark beside
  /// it should not have to reach past this for the privilege.
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    // The label and the control share the top line; the description gets the
    // width of the row to itself underneath. Side by side was the first shape
    // and it broke on the widest control here: two buttons pushed the sentence
    // into a third of the dialog, where four words took three lines and the
    // row's height jumped every time the control changed. The description is
    // prose and wants a measure; the control is a fixed thing and wants an
    // edge to sit against.
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-ui font-medium">
          {label}
        </label>
        <div className="shrink-0">{children}</div>
      </div>
      <p className="text-ui text-muted-foreground">{description}</p>
    </div>
  );
}

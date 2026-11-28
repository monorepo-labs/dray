import { ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { serverName, useServers } from "@/lib/servers";
import { invoke, listen, LOCAL, type ServerId } from "@/lib/transport";

type SecretSummary = { name: string; modified: string; always?: boolean };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/// Saved secrets on one machine at a time, picked at the top. A value is
/// written here and never read back: the server answers names alone. Agents
/// ask for new ones with a card in chat, and Save to Vault there lands one here.
export default function SecretsSettings() {
  const remotes = useServers().filter((s) => !s.cloud && s.status === "connected");
  const machines: ServerId[] = [LOCAL, ...remotes.map((s) => s.id)];
  const [picked, setPicked] = useState<ServerId>(LOCAL);
  // A machine that went away takes the pick back to this one.
  const server = machines.includes(picked) ? picked : LOCAL;
  return <Machine key={server} server={server} machines={machines} onPick={setPicked} />;
}

function Machine({ server, machines, onPick }: { server: ServerId; machines: ServerId[]; onPick: (s: ServerId) => void }) {
  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The dialog open: `{}` adds, a secret replaces that one.
  const [editing, setEditing] = useState<{ secret?: SecretSummary } | null>(null);

  const read = useCallback(() => {
    invoke<SecretSummary[]>("list_secrets", {}, server)
      .then((list) => {
        setSecrets(list);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [server]);

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    void listen("secrets_changed", ({ server: from }) => {
      if (from === server) read();
    }).then((unlisten) => {
      if (!live) return unlisten();
      off = unlisten;
    });
    read();
    return () => {
      live = false;
      off?.();
    };
  }, [server, read]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2 max-w-64 gap-1 px-2 text-ui font-medium">
              <span className="truncate">{serverName(server)}</span>
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={server} onValueChange={(v) => onPick(v as ServerId)}>
              {machines.map((m) => (
                <DropdownMenuRadioItem key={m} value={m}>
                  {serverName(m)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing({})}
          className="h-7 gap-1 px-2 text-ui text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3.5" />
          Add secret
        </Button>
      </div>
      {error ? (
        <p className="text-ui text-destructive">{error}</p>
      ) : secrets === null ? null : secrets.length === 0 ? (
        <p className="text-ui text-muted-foreground">None saved yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {secrets.map((s) => (
            <SecretRow key={s.name} server={server} secret={s} onReplace={() => setEditing({ secret: s })} />
          ))}
        </ul>
      )}
      {editing && (
        <SecretDialog server={server} secret={editing.secret} saved={secrets ?? []} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function SecretRow({ server, secret, onReplace }: { server: ServerId; secret: SecretSummary; onReplace: () => void }) {
  const [mode, setMode] = useState<"idle" | "delete">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    setBusy(true);
    invoke("delete_secret", { name: secret.name }, server).catch((e) => {
      setError(String(e));
      setBusy(false);
      setMode("idle");
    });
  };
  const setAuto = (on: boolean) =>
    void invoke("set_secret_always", { name: secret.name, on }, server).catch((e) => setError(String(e)));
  return (
    <li className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium">{secret.name}</span>
          <span className="truncate text-ui text-muted-foreground">Saved {when(secret.modified)}</span>
        </div>
        {mode === "delete" ? (
          <CancelOrConfirm verb="Delete" busy={busy} autoFocus onCancel={() => setMode("idle")} onConfirm={remove} />
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <label className="flex items-center gap-2 text-ui text-muted-foreground">
                  Auto
                  <Switch aria-label={`Let agents use ${secret.name} without asking`} checked={!!secret.always} onCheckedChange={setAuto} />
                </label>
              </TooltipTrigger>
              <TooltipContent side="bottom">Let agents use it without asking</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`${secret.name} options`}>
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-36">
                <DropdownMenuItem onSelect={onReplace}>Replace</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setMode("delete")}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {error && <p className="text-ui text-destructive">{error}</p>}
    </li>
  );
}

/// Adds a secret, or replaces `secret`'s value with its name fixed. The value
/// is read off the field at save and never held in state. Auto is set after
/// the value lands, since the server only takes it for a saved name.
export function SecretDialog({
  server,
  secret,
  saved,
  onClose,
}: {
  server: ServerId;
  secret?: SecretSummary;
  saved: SecretSummary[];
  onClose: () => void;
}) {
  const replacing = secret !== undefined;
  const [newName, setNewName] = useState("");
  const [filled, setFilled] = useState(false);
  const [auto, setAuto] = useState(!!secret?.always);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const name = secret?.name ?? newName.trim();
  const nameOk = NAME.test(name);
  // Adding under a saved name overwrites it, which the reader should know.
  const existing = saved.find((s) => s.name === name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = valueRef.current?.value.trim() ?? "";
    if (!nameOk || !value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("save_secret", { name, value }, server);
      if (valueRef.current) valueRef.current.value = "";
      if (auto !== !!existing?.always) await invoke("set_secret_always", { name, on: auto }, server);
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent
        className="grid-cols-[minmax(0,1fr)]"
        showClose={false}
        // Radix focuses the first field, which on Replace is the fixed name.
        onOpenAutoFocus={(e) => {
          if (!replacing) return;
          e.preventDefault();
          valueRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{replacing ? "Replace secret" : "Add secret"}</DialogTitle>
          <DialogDescription>
            Saved on {server === LOCAL ? "this machine" : serverName(server)}. Its value can't be read back.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} autoComplete="off" className="flex flex-col gap-3">
          <Field
            label="Name"
            hint={
              !replacing && newName.trim() !== "" && !nameOk
                ? "Letters, digits and _, like GITHUB_TOKEN."
                : !replacing && existing
                  ? `${name} is saved already; this replaces it.`
                  : undefined
            }
          >
            <Input
              autoFocus={!replacing}
              readOnly={replacing}
              tabIndex={replacing ? -1 : undefined}
              placeholder="GITHUB_TOKEN"
              className="font-mono read-only:text-muted-foreground"
              value={secret?.name ?? newName}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setNewName(e.currentTarget.value)}
              aria-invalid={(!replacing && newName.trim() !== "" && !nameOk) || undefined}
            />
          </Field>
          <Field label="Value">
            <Input
              ref={valueRef}
              // Masked text rather than a password field, so no password
              // manager offers to save it or fill it in.
              type="text"
              name={`dray-secret-${secret?.name ?? "new"}`}
              placeholder="Paste the value"
              className="[-webkit-text-security:disc]"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
              disabled={busy}
              onChange={(e) => setFilled(e.currentTarget.value.trim() !== "")}
            />
          </Field>
          <label className="flex items-center gap-2 text-ui text-muted-foreground">
            <Switch checked={auto} onCheckedChange={setAuto} disabled={busy} />
            Let agents use it without asking you
          </label>
          {error && <p className="text-ui text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !filled || !nameOk}>
              {busy ? "Saving…" : replacing ? "Replace" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/// A labelled field, as Settings' server dialogs lay them out.
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-ui font-medium">{label}</span>
      {children}
      {hint && <span className="text-ui text-muted-foreground">{hint}</span>}
    </label>
  );
}

function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

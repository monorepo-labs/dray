import { ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import { Button } from "@/components/ui/button";
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
/// ask for new ones with a card in chat, and Save as there lands one here.
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
  const [adding, setAdding] = useState(false);

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
        {!adding && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
            className="h-7 gap-1 px-2 text-ui text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3.5" />
            Add secret
          </Button>
        )}
      </div>
      {adding && <ValueForm server={server} onDone={() => setAdding(false)} />}
      {error ? (
        <p className="text-ui text-destructive">{error}</p>
      ) : secrets === null ? null : secrets.length === 0 ? (
        !adding && <p className="text-ui text-muted-foreground">None saved on {serverName(server)}.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {secrets.map((s) => (
            <SecretRow key={s.name} server={server} secret={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SecretRow({ server, secret }: { server: ServerId; secret: SecretSummary }) {
  const [mode, setMode] = useState<"idle" | "replace" | "delete">("idle");
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
          <span className="truncate font-mono text-ui font-medium">{secret.name}</span>
          <span className="truncate text-ui text-muted-foreground">Saved {when(secret.modified)}</span>
        </div>
        {mode === "delete" ? (
          <CancelOrConfirm verb="Delete" busy={busy} autoFocus onCancel={() => setMode("idle")} onConfirm={remove} />
        ) : (
          <div className="flex shrink-0 items-center gap-3">
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
                <Button variant="ghost" size="icon-sm" aria-label={`${secret.name} options`} className="text-muted-foreground">
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-36">
                <DropdownMenuItem onSelect={() => setMode("replace")}>Replace</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setMode("delete")}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {mode === "replace" && <ValueForm server={server} name={secret.name} onDone={() => setMode("idle")} />}
      {error && <p className="text-ui text-destructive">{error}</p>}
    </li>
  );
}

/// A name (for a new one) and a masked value. The value is read off the field
/// at save and never held in state.
function ValueForm({ server, name, onDone }: { server: ServerId; name?: string; onDone: () => void }) {
  const [newName, setNewName] = useState("");
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const finalName = name ?? newName.trim();
  const nameOk = NAME.test(finalName);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = valueRef.current?.value.trim() ?? "";
    if (!nameOk || !value || busy) return;
    setBusy(true);
    setError(null);
    invoke("save_secret", { name: finalName, value }, server)
      .then(() => {
        if (valueRef.current) valueRef.current.value = "";
        onDone();
      })
      .catch((err) => {
        setError(String(err));
        setBusy(false);
      });
  };

  return (
    <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-1.5 pb-1.5">
      <div className="flex items-center gap-2">
        {name === undefined && (
          <Input
            autoFocus
            placeholder="NAME"
            aria-label="Name"
            className="w-48 shrink-0 font-mono"
            value={newName}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setNewName(e.currentTarget.value)}
            aria-invalid={(newName.trim() !== "" && !nameOk) || undefined}
          />
        )}
        <Input
          ref={valueRef}
          autoFocus={name !== undefined}
          type="text"
          name={`dray-secret-${name ?? "new"}`}
          aria-label="Value"
          placeholder={name ? `New value for ${name}` : "Value"}
          className="[-webkit-text-security:disc] font-mono"
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
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !filled || !nameOk}>
          Save
        </Button>
      </div>
      {newName.trim() !== "" && !nameOk && (
        <p className="text-ui text-muted-foreground">Letters, digits and _, like GITHUB_TOKEN.</p>
      )}
      {error && <p className="text-ui text-destructive">{error}</p>}
    </form>
  );
}

function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

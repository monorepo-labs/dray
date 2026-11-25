import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { serverName, useServers } from "@/lib/servers";
import { invoke, listen, LOCAL, type ServerId } from "@/lib/transport";

type SecretSummary = { name: string; modified: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/// Saved secrets on each machine, by name. A value is written here and never
/// read back: the server answers names alone. Agents ask for new ones with a
/// card in chat, and Save as there lands one in this list.
export default function SecretsSettings() {
  const remotes = useServers().filter((s) => !s.cloud && s.status === "connected");
  return (
    <div className="flex flex-col gap-6">
      <Machine server={LOCAL} />
      {remotes.map((s) => (
        <Machine key={s.id} server={s.id} />
      ))}
    </div>
  );
}

function Machine({ server }: { server: ServerId }) {
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

  const name = serverName(server);
  return (
    <section className="flex flex-col gap-1">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h3 className="text-ui font-medium">{name}</h3>
        {!adding && (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add secret
          </Button>
        )}
      </div>
      {adding && <ValueForm server={server} onDone={() => setAdding(false)} />}
      {error ? (
        <p className="text-ui text-destructive">{error}</p>
      ) : secrets === null ? null : secrets.length === 0 ? (
        !adding && (
          <p className="text-ui text-muted-foreground">
            None saved. When an agent asks for one in chat, Save as keeps it here for every task on this machine.
          </p>
        )
      ) : (
        <ul className="flex flex-col">
          {secrets.map((s) => (
            <SecretRow key={s.name} server={server} secret={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SecretRow({ server, secret }: { server: ServerId; secret: SecretSummary }) {
  const [mode, setMode] = useState<"idle" | "replace" | "delete">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    setBusy(true);
    invoke("delete_secret", { name: secret.name }, server)
      .catch((e) => {
        setError(String(e));
        setBusy(false);
        setMode("idle");
      });
  };
  return (
    <li className="flex flex-col gap-2 py-1.5">
      <div className="flex min-h-7 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-mono text-ui">{secret.name}</span>
          <span className="text-ui text-muted-foreground">Saved {when(secret.modified)}</span>
        </div>
        {mode === "delete" ? (
          <CancelOrConfirm verb="Delete" busy={busy} autoFocus onCancel={() => setMode("idle")} onConfirm={remove} />
        ) : (
          mode === "idle" && (
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setMode("replace")}>
                Replace
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode("delete")}>
                Delete
              </Button>
            </div>
          )
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

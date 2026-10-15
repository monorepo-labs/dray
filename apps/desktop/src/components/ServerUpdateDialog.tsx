import { useCallback, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { serverName } from "@/lib/servers";
import { invoke, LOCAL } from "@/lib/transport";
import type { UpdateChannel } from "@/types/events";

/// How long the install waits on servers updating before it goes ahead. Each
/// server carries on with its own update either way; this only bounds how
/// long the reader watches a spinner.
const SERVER_WAIT_MS = 120_000;

/// Restart to update, asking first whether to update the servers with a newer
/// release out on their own channel — all of them or none. On a beta app only
/// beta servers count; on stable, every one. With none it is the install,
/// straight away.
export function useInstallWithServers(channel: UpdateChannel, install: () => Promise<unknown>) {
  const [behind, setBehind] = useState<string[] | null>(null);
  const [updating, setUpdating] = useState(false);
  // A server whose update failed, said before the restart takes the dialog
  // away — afterwards its row still offers the update, but not why it failed.
  const [failed, setFailed] = useState<string[]>([]);
  const primary = useRef<HTMLButtonElement>(null);

  const request = useCallback(() => {
    invoke<string[]>("servers_behind", { beta: channel === "beta" }, LOCAL)
      .then((ids) => {
        setFailed([]);
        if (ids.length) setBehind(ids);
        else void install();
      })
      .catch(() => install());
  }, [channel, install]);

  const restart = () => {
    setBehind(null);
    void install();
  };

  const both = () => {
    if (!behind) return;
    setUpdating(true);
    const updates = Promise.allSettled(
      behind.map((server) => invoke("update_server", { server }, LOCAL)),
    );
    const cap = new Promise<null>((resolve) => setTimeout(() => resolve(null), SERVER_WAIT_MS));
    void Promise.race([updates, cap]).then((settled) => {
      setUpdating(false);
      const errors = (settled ?? []).flatMap((result, i) =>
        result.status === "rejected" ? [`${serverName(behind[i])}: ${String(result.reason)}`] : [],
      );
      if (errors.length) setFailed(errors);
      else restart();
    });
  };

  const count = behind?.length ?? 0;
  const dialog = (
    <AlertDialog open={behind !== null} onOpenChange={(open) => !open && !updating && setBehind(null)}>
      <AlertDialogContent
        // The reader pressed Restart to update, so Enter goes on to the
        // default rather than to whichever button Radix would pick.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          primary.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {failed.length
              ? "Some servers couldn't update"
              : `${count === 1 ? "1 server has" : `${count} servers have`} an update too`}
          </AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {failed.length ? failed.join("\n") : "They update now and restart once their agents finish."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {failed.length ? (
            <Button ref={primary} size="sm" className="text-ui" onClick={restart}>
              Restart anyway
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" className="text-ui" disabled={updating} onClick={restart}>
                App only
              </Button>
              <Button ref={primary} size="sm" className="text-ui" disabled={updating} onClick={both}>
                {updating && <Spinner className="size-3.5" />}
                {updating ? "Updating servers…" : "Update app and servers"}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { request, dialog };
}

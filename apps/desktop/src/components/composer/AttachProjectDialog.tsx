import { homeDir } from "@tauri-apps/api/path";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, Folder } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { MissingCli } from "@/components/PrPanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import Spinner from "@/components/ui/spinner";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { serverName, useServers } from "@/lib/servers";
import { invoke, listen, LOCAL, qualify, type ServerId } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { CloneProgress, GithubRepo, PrUnavailable, Project } from "@/types/events";

/// The last list each server answered, drawn at once while a fresh one is read
/// behind it — a long account pages through `gh` for a second or two. Kept in
/// local storage so the first open after a launch is instant too; a stale
/// Attached or Cloned mark lasts only until that read lands.
const REPOS_KEY = "ade.githubRepos";
const lastRead = {
  get: (server: ServerId) => readLocalStorage<Record<string, GithubRepo[]>>(REPOS_KEY, {})[server],
  set: (server: ServerId, list: GithubRepo[]) =>
    writeLocalStorage(REPOS_KEY, { ...readLocalStorage(REPOS_KEY, {}), [server]: list }),
};

/// Attaching a project on any server: a GitHub repo the reader can reach,
/// cloned into `~/dray` on that machine, or a folder already there. On a remote
/// server this is the only way in, since the Mac's folder dialog cannot see it.
/// See ATTACH-PLAN.md.
export default function AttachProjectDialog({
  open,
  onClose,
  initialServer,
  projects,
  onAttached,
}: {
  open: boolean;
  onClose: () => void;
  /// The server the picker is showing, which is where the reader most likely
  /// means to attach.
  initialServer: ServerId;
  projects: Project[];
  /// Every route ends in the list `add_project` answers for `server`.
  onAttached: (server: ServerId, list: Project[]) => void;
}) {
  const remotes = useServers().filter((s) => s.status === "connected");
  const [server, setServer] = useState<ServerId>(LOCAL);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [unavailable, setUnavailable] = useState<PrUnavailable | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  /// The path field is behind a button: most attaches are a repo or the
  /// folder dialog, and a field always on screen read as the main way in.
  const [typing, setTyping] = useState(false);
  /// A row picks; Attach acts. Cloning is too big a thing to start on a click
  /// meant to look at the list.
  const [picked, setPicked] = useState<string | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [home, setHome] = useState("/");

  // Reset on open rather than on close, so a clone the reader closed the
  // dialog on still lands in state nobody has wiped from under it.
  useEffect(() => {
    if (!open) return;
    setServer(initialServer === LOCAL || remotes.some((s) => s.id === initialServer) ? initialServer : LOCAL);
    setQuery("");
    setPath("");
    setTyping(false);
    setFailure(null);
    // A browser has no Mac to ask, and throws rather than rejecting.
    try {
      void homeDir().then(setHome, () => {});
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The server on screen now, which a read landing after a switch is checked
  // against rather than the one its closure saw.
  const search = useRef<HTMLInputElement>(null);
  const current = useRef(server);
  current.current = server;

  const read = () => {
    const asked = server;
    setRepos(lastRead.get(asked) ?? null);
    setUnavailable(null);
    setLoading(true);
    invoke<GithubRepo[]>("github_repos", {}, asked)
      .then((list) => {
        lastRead.set(asked, list);
        if (asked === current.current) setRepos(list);
      })
      .catch((e: unknown) => {
        if (asked !== current.current) return;
        // A typed reason from `gh`, or the transport's own sentence.
        setUnavailable(e && typeof e === "object" && "kind" in e ? (e as PrUnavailable) : { kind: "other", detail: String(e) });
      })
      .finally(() => asked === current.current && setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server]);

  useEffect(() => {
    if (!cloning) return;
    const pending = listen<CloneProgress>("clone_progress", ({ payload, server: from }) => {
      if (from === server && payload.slug === cloning) setProgress(payload.line);
    });
    return () => void pending.then((unlisten) => unlisten());
  }, [cloning, server]);

  const attach = async (run: () => Promise<Project[]>) => {
    setFailure(null);
    try {
      const list = await run();
      onAttached(server, list);
      onClose();
    } catch (e) {
      setFailure(String(e));
    }
  };

  const attached = new Set(projects.map((p) => p.path));
  const needle = query.trim().toLowerCase();
  const shown = (repos ?? []).filter(
    (r) => !needle || r.slug.toLowerCase().includes(needle) || r.description?.toLowerCase().includes(needle),
  );
  const where = server === LOCAL ? "this Mac" : serverName(server);
  // A pick the search has since hidden is not one the reader can see they
  // are attaching.
  const repo = shown.find((r) => r.slug === picked);
  const ready = typing ? !!path.trim() : !!repo;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (cloning || !ready) return;
    if (typing) return attach(() => invoke<Project[]>("add_project", { path: path.trim() }, server));
    if (!repo) return;
    if (repo.path) return attach(() => invoke<Project[]>("add_project", { path: repo.path }));
    setCloning(repo.slug);
    setProgress("");
    await attach(() => invoke<Project[]>("clone_github_repo", { slug: repo.slug }, server));
    setCloning(null);
  };

  const chooseFolder = async () => {
    const folder = await openFolder({ directory: true, multiple: false });
    if (typeof folder === "string") void attach(() => invoke<Project[]>("add_project", { path: folder }, LOCAL));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* One `minmax(0, 1fr)` column, or a long description widens the grid
          past the frame rather than truncating. Focus goes to the search box,
          not to the first tabbable thing, which is the server picker. */}
      <DialogContent
        className="max-w-lg grid-cols-1"
        showClose={false}
        onOpenAutoFocus={(e) => {
          if (!search.current) return;
          e.preventDefault();
          search.current.focus();
        }}
      >
        <DialogHeader>
          {/* The server sits where the close cross would: one control at the
              title's end, and the description keeps its full measure. Drawn
              only once a server is added — with none there is no choice. */}
          <div className="flex min-h-7 items-center gap-2">
            <DialogTitle>Attach project</DialogTitle>
            {remotes.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto justify-between gap-1.5 font-normal"
                    disabled={!!cloning}
                  >
                    {serverName(server)}
                    <ChevronDown className="size-3 shrink-0 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup value={server} onValueChange={setServer}>
                    {[LOCAL, ...remotes.map((s) => s.id)].map((id) => (
                      <DropdownMenuRadioItem key={id} value={id} className="text-ui">
                        {serverName(id)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <DialogDescription>
            Pick a GitHub repository to clone into <code>~/dray</code>, or a folder already on {where}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex h-72 flex-col gap-2">
          {unavailable?.kind === "no_cli" || unavailable?.kind === "not_authenticated" ? (
            <MissingCli
              kind={unavailable.kind}
              cwd={server === LOCAL ? home : qualify("/", server)}
              loading={loading}
              refresh={read}
              lead={
                unavailable.kind === "no_cli"
                  ? `Dray lists your repositories through GitHub's CLI, which is not on ${where}.${server === LOCAL ? "" : " Run this there:"}`
                  : `GitHub's CLI on ${where} is not logged in.${server === LOCAL ? "" : " Run this there:"}`
              }
            />
          ) : (
            <>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search repositories"
                className="text-ui md:text-ui"
                aria-label="Search repositories"
                ref={search}
              />
              <div className="min-h-0 flex-1 overflow-y-auto">
                {unavailable ? (
                  <p className="p-2 text-ui text-destructive">{unavailable.kind === "other" ? unavailable.detail : "Could not read repositories."}</p>
                ) : !repos ? (
                  <p className="flex items-center gap-2 p-2 text-ui text-muted-foreground">
                    <Spinner className="size-3.5" />
                    Reading your repositories…
                  </p>
                ) : !shown.length ? (
                  <p className="p-2 text-ui text-muted-foreground">{repos.length ? "No repository matches." : "No repositories."}</p>
                ) : (
                  shown.map((r) => (
                    <RepoRow
                      key={r.slug}
                      repo={r}
                      mark={r.path ? (attached.has(r.path) ? "Attached" : "Cloned") : null}
                      selected={!typing && picked === r.slug}
                      cloning={cloning === r.slug}
                      progress={progress}
                      // Already a project here: nothing for Attach to do.
                      disabled={!!cloning || (!!r.path && attached.has(r.path))}
                      onPick={() => {
                        setPicked(r.slug);
                        setTyping(false);
                      }}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {failure && <p className="text-ui whitespace-pre-wrap text-destructive">{failure}</p>}

        {/* One row either way: the path field takes the place of the two
            ways in it would otherwise sit beside. */}
        <form onSubmit={(e) => void submit(e)} className="flex items-center gap-1">
          {typing ? (
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={server === LOCAL ? "~/code/project" : `A folder on ${where}, like ~/code/project`}
              aria-label={`Folder on ${where}`}
              disabled={!!cloning}
              className="mr-1 flex-1 text-ui md:text-ui"
              autoFocus
            />
          ) : (
            // The folder dialog sees this Mac alone.
            server === LOCAL && (
              <Button type="button" variant="ghost" disabled={!!cloning} onClick={() => void chooseFolder()}>
                <Folder className="size-3.5 fill-current" />
                Select folder
              </Button>
            )
          )}
          <Button type="button" variant="ghost" disabled={!!cloning} onClick={() => setTyping((t) => !t)}>
            {typing ? "Cancel" : "Enter path"}
          </Button>
          <Button type="submit" className="ml-auto" disabled={!!cloning || !ready}>
            {cloning ? "Cloning…" : "Attach"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepoRow({
  repo,
  mark,
  selected,
  cloning,
  progress,
  disabled,
  onPick,
}: {
  repo: GithubRepo;
  mark: "Attached" | "Cloned" | null;
  selected: boolean;
  cloning: boolean;
  progress: string;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        // Light takes the page's own colour: on a near-white dialog `--accent`
        // is a grey that reads as disabled. Dark keeps the accent step.
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-background/60 focus-visible:bg-background/60 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-accent/60 dark:focus-visible:bg-accent/60",
        // `--shadow-card` is `none` in dark, so it needs no variant of its own.
        selected &&
          "bg-background shadow-(--shadow-card) hover:bg-background disabled:hover:bg-background dark:bg-accent dark:hover:bg-accent dark:disabled:hover:bg-accent",
        disabled && !cloning && "opacity-50",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui">{repo.slug}</span>
          {mark && <span className="shrink-0 text-ui text-muted-foreground">{mark}</span>}
        </span>
        {(cloning || repo.description) && (
          <span className="truncate text-ui text-muted-foreground">
            {cloning ? progress || "Cloning…" : repo.description}
          </span>
        )}
      </span>
      {/* Held open on every row, so picking one moves no text. Centred on the
          whole row rather than its first line. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {cloning ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : (
          selected && <Check className="size-3.5" />
        )}
      </span>
    </button>
  );
}

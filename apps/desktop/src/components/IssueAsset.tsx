import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Download, File } from "lucide-react";

import ImageLightbox from "@/components/chat/ImageLightbox";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { IssueAsset } from "@/types/events";

/// A file uploaded to an issue, fetched through the backend rather than by the
/// webview.
///
/// **Linear serves its uploads behind the same auth its API is behind**, so an
/// `<img src="https://uploads.linear.app/…">` resolves to a 401 and the webview
/// draws its own broken-image box — which reads as the app being unable to show
/// the picture rather than as the picture needing a key. Everything here exists
/// to put the key on that request: the backend fetches the bytes and hands back
/// a `data:` URL, and only then is there something a `src` can point at.
///
/// Cached per URL across mounts, `null` included. A description is re-rendered
/// on every keystroke in the page's search box and on every panel refresh, and
/// each of those would otherwise re-download every screenshot in it.
const cache = new Map<string, IssueAsset | null>();
const inFlight = new Map<string, Promise<IssueAsset | null>>();

function load(url: string): Promise<IssueAsset | null> {
  const cached = cache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  // Deduped, because one description can name the same image twice and React
  // may mount both halves in the same frame.
  const running = inFlight.get(url);
  if (running) return running;

  const request = invoke<IssueAsset>("fetch_issue_asset", { url })
    .catch(() => null)
    .then((asset) => {
      cache.set(url, asset);
      inFlight.delete(url);
      return asset;
    });

  inFlight.set(url, request);
  return request;
}

function useAsset(url: string): { asset: IssueAsset | null; loading: boolean } {
  const [asset, setAsset] = useState<IssueAsset | null>(() => cache.get(url) ?? null);
  const [loading, setLoading] = useState(() => !cache.has(url));

  useEffect(() => {
    if (cache.has(url)) {
      setAsset(cache.get(url) ?? null);
      setLoading(false);
      return;
    }

    let live = true;
    setLoading(true);
    void load(url).then((next) => {
      if (!live) return;
      setAsset(next);
      setLoading(false);
    });

    return () => {
      live = false;
    };
  }, [url]);

  return { asset, loading };
}

/// An image from an issue's description, drawn as an image and openable full
/// size.
///
/// Falls back to the file card below rather than to a broken image: anything
/// the webview will not render — an SVG it refuses, a format it does not know,
/// a fetch that failed — is still a file somebody can download, and a card
/// saying so beats a grey box saying nothing.
///
/// The lightbox is the transcript's own, and it earns its place here for the
/// same reason it does there and more so: this pane is a third of the window,
/// so a screenshot of a screen is unreadable at the only width it can be given.
/// One image per lightbox rather than the description's whole set — these are
/// spread through prose rather than gathered in a row, so there is no set the
/// arrows would be stepping through.
export function IssueImage({ src, alt }: { src: string; alt?: string }) {
  const { asset, loading } = useAsset(src);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);

  if (loading) {
    return <span className="my-1 block h-24 w-full animate-pulse rounded-lg bg-muted/50" />;
  }

  if (!asset || broken || !asset.mime.startsWith("image/")) {
    return <IssueFile href={src} name={alt || "Image"} />;
  }

  const name = alt || "Image";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-1 block max-w-full cursor-zoom-in"
      >
        <img
          src={asset.dataUrl}
          alt={alt ?? ""}
          // `onError` is the second net under the mime check: a mime can say
          // `image/svg+xml` and still not render, and the fallback is a real
          // card rather than the browser's own broken glyph.
          onError={() => setBroken(true)}
          className="max-w-full rounded-lg border border-border"
        />
      </button>

      <ImageLightbox
        images={[{ src: asset.dataUrl, name }]}
        index={open ? 0 : null}
        onIndex={() => {}}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/// A file from an issue's description — the shape Linear itself draws.
///
/// Name, size, and a download that appears under the cursor. The whole row is
/// the control, so the glyph on the right is a hint about what a click does
/// rather than a second target to aim at.
export function IssueFile({ href, name }: { href: string; name: string }) {
  const { asset, loading } = useAsset(href);

  const download = () => {
    if (!asset) return;
    // Through an anchor rather than `openUrl`: the bytes are already here as a
    // `data:` URL, and `download` is what gives the file its name back — the
    // URL itself is an opaque key with no name in it.
    const link = document.createElement("a");
    link.href = asset.dataUrl;
    link.download = name;
    link.click();
  };

  return (
    <button
      type="button"
      onClick={download}
      disabled={!asset}
      title={name}
      className={cn(
        "group/file my-1 flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors",
        asset ? "hover:bg-sidebar-accent/50" : "cursor-default",
      )}
    >
      <File className="size-5 shrink-0 text-muted-foreground" />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-chat">{name}</span>
        <span className="text-ui text-muted-foreground">
          {loading ? "Loading…" : asset ? formatBytes(asset.bytes) : "Unavailable"}
        </span>
      </span>

      {asset && (
        <Download className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/file:opacity-100" />
      )}
    </button>
  );
}

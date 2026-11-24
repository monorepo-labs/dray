import { useCallback, useEffect, useState } from "react";

import { ArrowUpCircleIcon, SparklesIcon, WrenchIcon } from "@heroicons/react/16/solid";

import { changelogInline } from "@/components/changelogText";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import {
  fetchChangelog,
  forChannel,
  type ChangelogItem,
  type Release,
} from "@/lib/changelog";
import { useFirstFrame } from "@/hooks/useFirstFrame";
import { cn } from "@/lib/utils";
import type { UpdateChannel } from "@/types/events";

/// Each kind's mark and colour. Tokens, not literals, so both modes keep them
/// readable; yellow and red stay out, meaning "wants you" and "failed".
const CATEGORY = {
  new: { label: "New", Icon: SparklesIcon, color: "text-accent-add" },
  improved: { label: "Improved", Icon: ArrowUpCircleIcon, color: "text-accent-mention" },
  fixed: { label: "Fixed", Icon: WrenchIcon, color: "text-accent-issue" },
} as const;

function Item({ item }: { item: ChangelogItem }) {
  return (
    <li className="flex gap-2.5">
      {/* Hung on the first line's own height, so wrapped text lines up with
          the text rather than with the marker. */}
      <span aria-hidden className="flex h-[1lh] shrink-0 items-center">
        <span className="size-[5px] rounded-full bg-muted-foreground/60" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {item.title && <p className="font-medium text-foreground">{changelogInline(item.title)}</p>}
        {item.body.split("\n\n").map((p, i) => p && <p key={i}>{changelogInline(p)}</p>)}
        {item.media.map((m) =>
          m.kind === "video" ? (
            <Video key={m.url} url={m.url} alt={m.alt} />
          ) : (
            <img
              key={m.url}
              src={m.url}
              alt={m.alt}
              loading="lazy"
              className="mt-1 w-full rounded-lg border border-border"
            />
          ),
        )}
      </div>
    </li>
  );
}

function Video({ url, alt }: { url: string; alt: string }) {
  const first = useFirstFrame();
  return (
    <video
      src={url}
      aria-label={alt || undefined}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={first.onLoadedMetadata}
      className="mt-1 w-full rounded-lg border border-border"
    />
  );
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/// Every release, newest first, as drayhq.com/changelog draws it. The beta
/// channel sees betas too.
export default function ChangelogSettings({ channel }: { channel: UpdateChannel }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    fetchChangelog().then(setReleases, () => setFailed(true));
  }, []);
  useEffect(load, [load]);

  if (failed)
    return (
      <div className="flex items-center gap-3 text-ui text-muted-foreground">
        Couldn't load the changelog.
        <Button variant="outline" size="sm" onClick={load}>
          Try again
        </Button>
      </div>
    );
  if (!releases) return <Spinner className="size-4 text-muted-foreground" />;

  return (
    <div className="flex flex-col gap-10">
      {forChannel(releases, channel)
        .filter((r) => r.sections.length > 0)
        .map((r) => (
          <article key={r.version} className="flex flex-col gap-4">
            <header className="flex items-baseline gap-2 text-ui">
              <h2 className="font-medium text-foreground">{r.version}</h2>
              {r.date && (
                <time dateTime={r.date} className="text-muted-foreground">
                  {formatDate(r.date)}
                </time>
              )}
            </header>
            {r.sections.map((s) => {
              const { label, Icon, color } = CATEGORY[s.kind];
              return (
                <section key={s.kind} className="flex flex-col gap-2">
                  <h3 className={cn("flex items-center gap-1.5 text-ui font-medium", color)}>
                    <Icon className="size-3.5" aria-hidden />
                    {label}
                  </h3>
                  <ul className="flex flex-col gap-3 text-chat leading-relaxed text-muted-foreground">
                    {s.items.map((item, i) => (
                      <Item key={i} item={item} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </article>
        ))}
    </div>
  );
}

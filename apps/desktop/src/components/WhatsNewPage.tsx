import { changelogPlain } from "@/components/changelogText";
import WindowControls from "@/components/layout/WindowControls";
import { GateHeading } from "@/components/SignInGate";
import { Stripes } from "@/components/Stripes";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { ChangelogMedia, Highlight } from "@/lib/changelog";
import { cn } from "@/lib/utils";

/// A release's bigger features after an update, over the whole window like a
/// landing page's feature section: the site's blue closing band and its long
/// stripes, the heading counting what is new, and a white card per highlight,
/// its title first and its picture or video under it. Nothing opens; the
/// reader scans the cards and leaves by Continue, the grid's last slot, or
/// Escape. Picked over the paged dialog it replaced from the takes in
/// demo/whats-new-pages.html (F).
///
/// The app raised it rather than the reader, so every way out is the same
/// answer: seen, all of it. An action ends it as well, since the reader just
/// chose to go somewhere.
export default function WhatsNewPage({
  highlights,
  actionFor,
  onClose,
}: {
  highlights: Highlight[];
  /// What a target does here, or null for one this build does not know, which
  /// then draws no link.
  actionFor: (target: string) => (() => void) | null;
  onClose: () => void;
}) {
  const count = highlights.length;
  const heading = count === 1 ? "New in Dray." : `${count} new things in Dray.`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        // The page itself takes focus, not Continue: raised at launch with no
        // click before it, a focused button counts as keyboard focus and draws
        // its ring round a Continue meant to have no edge. Escape still
        // leaves, and Tab reaches every link and then Continue.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
        className="top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-[#1612F8] p-0 text-white shadow-none backdrop-blur-none select-none"
      >
        <DialogTitle className="sr-only">New in Dray</DialogTitle>
        {/* The site's closing band: its own black stripes at 12%. */}
        <Stripes ink="#0000001F" />
        <header data-tauri-drag-region="deep" className="relative flex h-(--titlebar-h,40px) shrink-0 items-center justify-end">
          <WindowControls />
        </header>
        <main className="relative min-h-0 flex-1 overflow-y-auto px-10 pb-12">
          <div className="mx-auto flex w-full max-w-[1120px] flex-col pt-6">
            <GateHeading>{heading}</GateHeading>
            <div className="grid grid-cols-2 gap-4">
              {highlights.map((h, i) => (
                <Card key={i} h={h} actionFor={actionFor} onClose={onClose} />
              ))}
              <Continue row={count % 2 === 0} onClose={onClose} />
            </div>
          </div>
        </main>
      </DialogContent>
    </Dialog>
  );
}

/// One feature: its title, which says the whole thing in two lines at most,
/// any action as a small link, and the picture or video held to the card's
/// foot so a row's pictures line up whatever their titles' lengths. A
/// highlight with no media is its title and link alone.
function Card({
  h,
  actionFor,
  onClose,
}: {
  h: Highlight;
  actionFor: (target: string) => (() => void) | null;
  onClose: () => void;
}) {
  const media = h.item.media[0];
  const action = h.item.highlight?.action ?? null;
  const run = action && actionFor(action.target);
  return (
    <article className="flex flex-col bg-white">
      <div className="flex flex-col gap-3 p-6">
        <h2 className="line-clamp-2 text-[20px] leading-7 tracking-[-0.01em] text-balance text-[#0A0A0A]">
          {changelogPlain(h.item.title ?? h.item.body)}
        </h2>
        {action && run && (
          <button
            type="button"
            onClick={() => {
              onClose();
              run();
            }}
            className="inline-flex cursor-pointer items-center gap-1.5 self-start font-mono text-[11px] leading-[14px] tracking-[0.06em] text-[#0A0A0A]/70 uppercase outline-none hover:text-[#0A0A0A] focus-visible:text-[#0A0A0A]"
          >
            {action.label}
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
              <path d="M7 17 17 7M7 7h10v10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      {media && <Media media={media} />}
    </article>
  );
}

function Media({ media }: { media: ChangelogMedia }) {
  const box = "mt-auto aspect-video w-full bg-white object-cover";
  return media.kind === "video" ? (
    <video src={media.url} aria-label={media.alt || undefined} autoPlay muted loop playsInline className={box} />
  ) : (
    <img src={media.url} alt={media.alt} className={box} />
  );
}

/// The way on, in the grid's last slot with no fill of its own: beside a card
/// (an odd count) a white hairline keeps it reading as that row's second
/// card; on a row of its own it is the label and arrow alone, the label
/// starting where the heading's ink does: GateHeading's 102px indent, and 2px
/// more for the "C"'s side bearing against the heading's digit, measured off
/// the pixels. The arrow slides on hover, unless motion is reduced.
export function Continue({ row, onClose, className }: { row: boolean; onClose: () => void; className?: string }) {
  const arrow = (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden
      className="motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out motion-safe:group-hover:translate-x-1.5 motion-safe:group-focus-visible:translate-x-1.5"
    >
      <path d="M4 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
  return (
    <button
      type="button"
      onClick={onClose}
      className={cn(
        "group flex cursor-pointer text-left text-white outline-none transition-colors hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-white/50",
        row
          ? "col-span-2 h-24 items-center justify-between pr-8 pl-[104px] max-lg:pl-0"
          : "min-h-48 flex-col justify-between border border-white/40 p-8",
        className,
      )}
    >
      {row ? (
        <>
          <span className="text-[24px] leading-8 tracking-[-0.01em]">Continue</span>
          {arrow}
        </>
      ) : (
        <>
          <span className="self-end">{arrow}</span>
          <span className="text-[28px] leading-9 tracking-[-0.02em]">Continue</span>
        </>
      )}
    </button>
  );
}

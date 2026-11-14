"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Blobatar } from "@blobatar/react";
import { useGaze } from "@blobatar/react/gaze";
import { idle } from "blobatar/expression";
import "blobatar/motion.css";
import "blobatar/gaze.css";
import { ChevronDown, CircleDashed, GitMerge, GitPullRequest, GitPullRequestDraft, Play, Server, X } from "lucide-react";

import { ClaudeGlyph } from "@/components/ClaudeGlyph";

import { Composer } from "./Chat";
import { cx } from "./Window";

/// A face's pick, as the app stores it: a shape by name and a hue in degrees.
export type Avatar = { shape: string; hue: number };

/// Blobatar's silhouettes at the middle of each band, `lib/botAvatar.ts`'s
/// table copied: the library picks a shape off a number, the bot stores a name.
const SHAPES = [
  { name: "round", position: 0.11 },
  { name: "organic", position: 0.35 },
  { name: "boxy", position: 0.54 },
  { name: "capsule", position: 0.65 },
  { name: "nub", position: 0.745 },
  { name: "cloud", position: 0.825 },
  { name: "hexagon", position: 0.9325 },
  { name: "sun", position: 0.965 },
  { name: "triangle", position: 0.99 },
] as const;

const HUES = [25, 50, 80, 145, 185, 250, 295, 340];

/// The app's picked-face tone. Left to the seed, most faces land pale.
const TONE = 0.55;

/// A face for something with no pick of its own, such as a task a bot
/// started — the app's `seededAvatar`, hash for hash, so a task drawn here
/// wears the face the app would give it.
export function seededAvatar(seed: string): Avatar {
  let hash = 0;
  for (const ch of seed) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return { shape: SHAPES[hash % SHAPES.length].name, hue: HUES[(hash >>> 8) % HUES.length] };
}

function faceProps(avatar: Avatar) {
  const shape = SHAPES.find((s) => s.name === avatar.shape) ?? SHAPES[0];
  return { traits: { shape: shape.position }, hue: avatar.hue, tone: TONE };
}

/// A bot's face, or a task's. `follow` points the eyes at the cursor, for a
/// row being hovered; `still` runs no gaze at all, for faces drawn many to a
/// chat, as the app's own `still` does.
export function BotFace({
  seed,
  avatar,
  follow = false,
  still = false,
  className,
}: {
  seed: string;
  avatar?: Avatar;
  follow?: boolean;
  still?: boolean;
  className?: string;
}) {
  const props = faceProps(avatar ?? seededAvatar(seed));
  return still ? (
    <Blobatar name={seed} aria-hidden expression={idle} animate="hover" {...props} className={cx("shrink-0", className)} />
  ) : (
    <GazingFace seed={seed} props={props} follow={follow} className={className} />
  );
}

function GazingFace({
  seed,
  props,
  follow,
  className,
}: {
  seed: string;
  props: ReturnType<typeof faceProps>;
  follow: boolean;
  className?: string;
}) {
  const { ref } = useGaze({ travel: 6, lookAt: follow ? "pointer" : "rest" });
  return (
    <Blobatar
      ref={ref}
      name={seed}
      aria-hidden
      expression={idle}
      animate={follow ? "always" : "hover"}
      {...props}
      className={cx("shrink-0", className)}
    />
  );
}

/// A face with a rounded hole where its badge sits, as a mask, since the
/// sidebar is glass and no ring of fill matches what shows through.
function cutout(width: number, height: number, face: number, gap = 2): string {
  const [x, y] = [face + 2 - width - gap, face + 2 - height - gap];
  const [w, h, r] = [width + gap * 2, height + gap * 2, (height + gap * 2) / 2];
  const hole = `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${face}" height="${face}"><path fill-rule="evenodd" d="M0 0H${face}V${face}H0Z${hole}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const DOT_CUTOUT = cutout(10, 10, 32);
const COUNT_CUTOUT = cutout(16, 16, 32);

/// A bot in the sidebar, as an inbox row: its face, its name and when it
/// last spoke, and its last reply under them — typing dots while it works.
export function BotRow({
  name,
  seed,
  avatar,
  time,
  preview,
  working = false,
  unread = 0,
  asking = false,
  active = false,
  onClick,
}: {
  name: string;
  seed: string;
  avatar: Avatar;
  time: string;
  preview: string;
  working?: boolean;
  /// Replies the reader has not read yet, drawn as a count on the face.
  unread?: number;
  /// Waiting on the reader: a yellow dot, which wins over the count.
  asking?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const badge = asking ? "asking" : unread ? "unread" : null;
  const mask = badge === "asking" ? DOT_CUTOUT : badge === "unread" ? COUNT_CUTOUT : undefined;
  const Row = onClick ? "button" : "div";
  return (
    <Row
      {...(onClick && { type: "button" as const, onClick, "aria-current": active || undefined })}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cx(
        "group relative flex w-full items-center gap-2 rounded-md py-1 pr-[5px] pl-1 text-left",
        "transition-[color,background-color] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50",
      )}
    >
      <span className="relative shrink-0">
        <span
          className="block size-8"
          style={mask ? { maskImage: mask, WebkitMaskImage: mask, maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" } : undefined}
        >
          <BotFace seed={seed} avatar={avatar} follow={hovered} className="block size-8 scale-[1.18]" />
        </span>
        {badge === "asking" && (
          <span role="img" aria-label="Waiting for you" className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-accent-command" />
        )}
        {badge === "unread" && (
          <span
            role="img"
            aria-label={`${unread} unread`}
            // The app's Dray theme: a red deeper than its own in dark, green in light.
            className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-[oklch(0.55_0.2_25)] text-[10px] leading-none font-semibold text-white tabular-nums light:bg-accent-add"
          >
            {unread}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-ui text-sidebar-foreground", unread > 0 && "font-medium")}>{name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">{time}</span>
        </span>
        {working ? (
          <span className="flex h-[1lh] items-center text-ui">
            <TypingDots />
          </span>
        ) : (
          <span className="truncate text-ui text-foreground/70">{preview}</span>
        )}
      </span>
    </Row>
  );
}

/// Three dots taking turns, a messenger's "typing".
export function TypingDots() {
  return (
    <span role="img" aria-label="Working" className="flex items-center gap-0.5">
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className="size-1 rounded-full bg-muted-foreground/70 motion-safe:animate-[typing-dot_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/// What the reader sent, in a bot's chat. Both sides are bubbles there, so
/// the reader's is filled blue in dark too, a step deeper than light's.
export function SentBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[85%] rounded-xl bg-[oklch(0.58_0.17_252)] px-3 py-2 text-chat text-[oklch(0.99_0_0)] light:bg-[oklch(0.65_0.17_250)]">
        {children}
      </div>
    </div>
  );
}

/// A bot's reply: a bubble on the left, quieter than the reader's. Replies in
/// a row sit close, as a messenger stacks them.
export function BotBubble({ tight = false, children }: { tight?: boolean; children: ReactNode }) {
  return (
    <div className={cx("max-w-[85%] self-start rounded-xl bg-muted/50 px-3 py-2 text-chat", tight && "-mt-2.5")}>
      {children}
    </div>
  );
}

/// A recording a bot sent, played inline under its words. The app's
/// `VideoPlayer` cut to its play button: a click on the frame plays or
/// pauses, and no control bar sits over the work it shows.
export function VideoPlayer({ src, className }: { src: string; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const v = video.current;
    if (v) void (v.paused ? v.play() : v.pause());
  };

  return (
    // `isolate`, or WebKit composites the video on a layer the radius does
    // not clip.
    <span className="relative isolate mt-1.5 block w-fit max-w-full overflow-hidden rounded-xl border border-border">
      <video
        ref={video}
        // `#t` paints the first frame as a thumbnail; `metadata` alone paints nothing.
        src={`${src}#t=0.001`}
        preload="metadata"
        playsInline
        muted
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        // Back to its first frame at the end, so the play button returns over
        // a picture of the start rather than of the last scroll.
        onEnded={(e) => {
          e.currentTarget.currentTime = 0;
        }}
        className={cx("block max-w-full", className)}
      />
      {/* One button over the whole frame, kept while it plays, so pausing is
          as reachable from the keyboard as playing. The round mark shows only
          at rest. */}
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={toggle}
        className="absolute inset-0 flex cursor-pointer items-center justify-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        {!playing && (
          <span className="flex size-12 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Play className="size-5 translate-x-px fill-current" />
          </span>
        )}
      </button>
    </span>
  );
}

/// The time a run of messages began, centred and quiet.
export function TimeLabel({ children }: { children: ReactNode }) {
  return <p className="self-center pt-2 text-[12px] text-muted-foreground/70">{children}</p>;
}

/// A task, by its face and title, in a pill of its own colour on hover.
function PartyChip({ id, title, onClick }: { id: string; title: string; onClick?: () => void }) {
  const { hue } = seededAvatar(id);
  const Chip = onClick ? "button" : "span";
  return (
    <Chip
      {...(onClick && { type: "button" as const, onClick })}
      className={cx(
        "flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pr-1.5 pl-1 transition-colors",
        onClick && "hover:bg-(--party-wash) hover:text-(--party-ink)",
      )}
      style={{ "--party-wash": `oklch(0.7 0.12 ${hue} / 0.16)`, "--party-ink": `oklch(0.78 0.12 ${hue})` } as CSSProperties}
    >
      <span className="size-5 shrink-0">
        <BotFace still seed={id} className="block size-5 scale-[1.18]" />
      </span>
      <span className="truncate">{title}</span>
    </Chip>
  );
}

/// A task the bot started: a line naming it, never a tool call. Whether it
/// is still working is the Tasks tab's to say.
export function TaskLine({ id, title, onClick }: { id: string; title: string; onClick?: () => void }) {
  return (
    <div className="flex max-w-full items-center gap-0.5 self-start text-ui text-muted-foreground">
      <span className="shrink-0">Started a new task</span>
      <PartyChip id={id} title={title} onClick={onClick} />
    </div>
  );
}

/// A pull request as the app marks one, the four GitHub states: `open`
/// takes `failing` to go red.
export type Pr = { number: number; state: "open" | "draft" | "merged"; failing?: boolean; running?: boolean };

export function PrIcon({ pr, className }: { pr: Pr; className?: string }) {
  const Icon = pr.state === "merged" ? GitMerge : pr.state === "draft" ? GitPullRequestDraft : GitPullRequest;
  const tone =
    pr.state === "merged"
      ? "text-accent-merged"
      : pr.failing
        ? "text-destructive"
        : pr.state === "draft"
          ? "text-muted-foreground"
          : "text-accent-add";
  return <Icon strokeWidth={1.5} className={cx("size-3.5 shrink-0", tone, className)} />;
}

/// CI still going: drawn in the PR glyph's place while it lasts.
export function ChecksRunning() {
  return (
    <CircleDashed
      strokeWidth={1.5}
      aria-label="Checks running"
      className="size-3.5 shrink-0 animate-spin text-accent-command [animation-duration:3s]"
    />
  );
}

const XS =
  "inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-[min(var(--radius-md),10px)] border border-transparent px-2 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
const MERGE_FILL = "bg-accent-merge text-accent-merge-foreground hover:bg-accent-merge-hover";
const BUTTON_SHADOW = "shadow-[0_1px_4px_oklch(0_0_0/45%)] light:shadow-[0_1px_3px_oklch(0_0_0/12%)]";

/// The PR panel's merge cut to a row: a split button, then a confirm step,
/// since a merge is the one thing here that cannot be undone. The confirm is
/// each control's own; `merging` is the PR's, so every control showing it
/// says so. `named` spells the method out, where there is room.
export function MergeControl({
  merging,
  named = false,
  onConfirm,
}: {
  merging: boolean;
  named?: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {confirming && !merging ? (
        <>
          <button type="button" onClick={() => setConfirming(false)} className={cx(XS, "hover:bg-muted")}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onConfirm();
            }}
            className={cx(XS, MERGE_FILL, BUTTON_SHADOW)}
          >
            {named ? "Confirm squash and merge" : "Confirm"}
          </button>
        </>
      ) : (
        <span className={cx("flex items-center rounded-[min(var(--radius-md),10px)]", BUTTON_SHADOW)}>
          <button
            type="button"
            disabled={merging}
            onClick={() => setConfirming(true)}
            className={cx(XS, MERGE_FILL, "rounded-r-none")}
          >
            {merging ? "Merging…" : named ? "Squash and merge" : "Merge"}
          </button>
          <span className={cx(XS, MERGE_FILL, "rounded-l-none px-1 shadow-[inset_1px_0_1px_oklch(1_0_0/10%)]")}>
            <ChevronDown className="size-3" />
          </span>
        </span>
      )}
    </span>
  );
}

/// A task's pull request, posted into the bot's chat once it can land. Whole
/// while it is open; one line once merged.
export function MergeCard({
  taskId,
  title,
  pr,
  merging,
  onConfirm,
}: {
  taskId: string;
  title: string;
  pr: Pr;
  merging: boolean;
  onConfirm: () => void;
}) {
  const face = <BotFace still seed={taskId} className="block size-full scale-[1.18]" />;
  if (pr.state === "merged") {
    return (
      <div className="flex max-w-full items-center gap-1.5 self-start text-ui text-muted-foreground">
        <PrIcon pr={pr} />
        <span className="shrink-0 tabular-nums">Merged #{pr.number}</span>
        <span aria-hidden>·</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="size-4 shrink-0">{face}</span>
          <span className="truncate">{title}</span>
        </span>
      </div>
    );
  }
  return (
    // Light lifts the card with the app's card shadow; dark has no drop to
    // cast, so a faint half-pixel edge draws it.
    <div className="w-full max-w-lg self-start rounded-2xl border-[0.5px] border-border/50 bg-card p-3.5 light:border-transparent light:shadow-[0_1px_1px_oklch(0_0_1/4%),0_1px_1px_oklch(0_0_0/6%),0_1px_4px_oklch(0_0_0/4%)]">
      <div className="flex items-center gap-2.5">
        <span className="size-7 shrink-0">{face}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-chat font-medium">{title}</p>
          <p className="flex items-center gap-1.5 text-ui text-muted-foreground">
            <PrIcon pr={pr} />
            <span className="tabular-nums">#{pr.number}</span>
          </p>
        </div>
        <MergeControl merging={merging} named onConfirm={onConfirm} />
      </div>
    </div>
  );
}

/// The foot of a bot's chat while any of its tasks waits on the reader: an
/// inbox row per task. Rows go as their tasks move; the card goes with the last.
export function WaitingCard({ onDismiss, children }: { onDismiss?: () => void; children: ReactNode }) {
  return (
    <div className="flex w-full flex-col rounded-xl border border-border/60 p-1">
      <div className="flex items-center py-0.5 pr-0.5 pl-2 text-ui text-muted-foreground">
        <span className="flex-1">Waiting on you</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="grid size-6 place-items-center rounded-[min(var(--radius-md),10px)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
      {children}
    </div>
  );
}

/// One task on the card: face, title and how long it has sat; under them,
/// the line its bot wrote for what it needs.
export function WaitingRow({ id, title, age, need }: { id: string; title: string; age: string; need?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/50"
    >
      <BotFace seed={id} follow={hovered} className="block size-8 shrink-0 scale-[1.18]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-ui text-foreground">{title}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">{age}</span>
        </span>
        {need && <span className="min-w-0 truncate text-ui text-foreground/70">{need}</span>}
      </span>
    </div>
  );
}

/// One of the bot's tasks on its Tasks tab: the face, or the orb while it
/// works; the title; the server mark where it runs on another machine; its
/// PR. A click opens the task.
export function TaskRow({
  id,
  title,
  working,
  machine = false,
  pr,
  onOpen,
}: {
  id: string;
  title: string;
  /// Stands in for the face while the task works.
  working?: ReactNode;
  machine?: boolean;
  pr?: Pr;
  onOpen?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {working ?? <BotFace seed={id} follow={hovered} className="block size-5 scale-[1.18]" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {machine && <MachineMark />}
      {pr && (
        <span className="flex shrink-0 items-center gap-1 rounded px-0.5 text-[12px] text-muted-foreground tabular-nums">
          {pr.running ? <ChecksRunning /> : <PrIcon pr={pr} />}
          <span>#{pr.number}</span>
        </span>
      )}
    </button>
  );
}

/// The server glyph on a task that runs on another machine.
export function MachineMark({ className }: { className?: string }) {
  return (
    <span aria-label="Runs on another machine" className={cx("flex shrink-0 text-muted-foreground", className)}>
      <Server className="size-3" />
    </span>
  );
}

/// The break between runs of the Tasks tab, as the sidebar's.
export function TaskBreak() {
  return <div aria-hidden className="h-4 shrink-0" />;
}

/// A bot's composer: the same one a task has, the model and stance row under
/// it, with a box the visitor types in. Enter sends.
export function BotComposer({
  value,
  onChange,
  onSend,
  placeholder = "Follow-up. @bots. /skills. &tasks.",
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
}) {
  return (
    <Composer
      mic
      agent={<ClaudeGlyph className="size-3.5" />}
      model="Opus 5.5"
      effort="High"
      mode="Auto"
      context={0.18}
      onSend={{ send: onSend, disabled: !value.trim() }}
      editor={
        <textarea
          rows={1}
          aria-label="Message the bot"
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // An IME's Enter picks a character; it is not a send.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          // `select-text` undoes the window's `select-none`, which Safari
          // reads as "this field takes no typing".
          className="field-sizing-content block max-h-28 w-full resize-none bg-transparent px-1 py-1 text-prompt text-foreground outline-none select-text placeholder:text-muted-foreground"
        />
      }
    />
  );
}

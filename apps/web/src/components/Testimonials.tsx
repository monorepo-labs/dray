import { TESTIMONIALS, type Testimonial } from "@/lib/testimonials";

/// X's verified mark. Local to this file rather than its own glyph component:
/// nothing else on the page names an account, so a second file would be one
/// import for one caller.
function VerifiedGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 22 22"
      fill="#1d9bf0"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Verified account"
      role="img"
      className={className}
    >
      <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.132-.634-.44-1.218-.888-1.685-.467-.447-1.05-.755-1.685-.887-.633-.13-1.29-.084-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.44-1.687.888-.445.468-.749 1.053-.878 1.687-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.816.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.219.878 1.687.467.447 1.052.755 1.687.885.635.13 1.294.081 1.902-.142.271.586.7 1.084 1.24 1.439.54.354 1.167.551 1.813.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
    </svg>
  );
}

/// The reaction to the app, as a wall of posts. Hand-rolled cards rather than
/// embeds — see src/lib/testimonials.ts for why the syndication API can't
/// serve these.
///
/// The cards are **compact and unfilled** — a hairline, 32px avatar, name and
/// handle stacked tight — because a roomy filled card is what made a four-word
/// reaction look like a mistake, and a row of filled boxes was the loudest
/// thing on a page that is otherwise text.
///
/// The whole card is the link, which is also why nothing inside it is one, and
/// why hovering fills it: the fill is the affordance the resting card gives up
/// by being a hairline.
/// `clone` marks a card the marquee only draws to fill the loop. It is hidden
/// from assistive tech and taken out of the tab order together — hiding it
/// alone would leave a link that can be focused but not read.
function Card({ t, clone = false }: { t: Testimonial; clone?: boolean }) {
  return (
    <a
      href={t.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-hidden={clone || undefined}
      tabIndex={clone ? -1 : undefined}
      className="flex w-72 shrink-0 rounded-xl border border-border/50 px-5 pt-5 pb-8 transition-colors hover:border-card hover:bg-card"
    >
      <figure>
        <figcaption className="flex items-center gap-2.5">
          {t.avatar ? (
            // Plain `img`, not `next/image`: these are 32px avatars whose files
            // are already small, so the optimizer's round trip buys nothing and
            // costs a required width/height pair per card.
            <img
              src={t.avatar}
              alt=""
              width={32}
              height={32}
              className="size-8 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-xs font-medium text-muted-foreground"
            >
              {t.name.charAt(0)}
            </span>
          )}
          {/* `min-w-0` on the wrapper is what lets the two truncations below
              actually fire: a flex child defaults to its content's width, so a
              long handle would push the card wide instead. */}
          <span className="min-w-0 leading-tight">
            <span className="flex items-center gap-1 text-sm font-medium">
              <span className="truncate">{t.name}</span>
              {t.verified && <VerifiedGlyph className="size-3.5 shrink-0" />}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              @{t.handle}
            </span>
          </span>
        </figcaption>
        <blockquote className="mt-2.5 text-[15px] leading-normal break-words text-pretty">
          {t.text}
        </blockquote>
      </figure>
    </a>
  );
}

/// One sliding row. The track slides by exactly **half** its own width, so what
/// it holds has to be the run twice over — hence `run` is already doubled by
/// the caller and drawn twice here. Doubling rather than laying the run out
/// once is what a short row needs: three cards are narrower than the window, so
/// half a two-copy track would leave a gap crossing the screen before the loop
/// came round.
///
/// Everything past the first run is a `clone`, hidden from assistive tech, or
/// the same quote is read out four times.
///
/// Motion pauses on hover, since the cards are links and a moving link cannot
/// be clicked. `prefers-reduced-motion` stops it outright, in globals.css.
function Row({
  run,
  reverse = false,
}: {
  run: Testimonial[];
  reverse?: boolean;
}) {
  return (
    <div
      className={`flex w-max gap-3 animate-marquee hover:[animation-play-state:paused] ${
        reverse ? "[animation-direction:reverse]" : ""
      }`}
    >
      {run.map((t, i) => (
        <Card key={`a${i}`} t={t} clone={i >= run.length / 2} />
      ))}
      {run.map((t, i) => (
        <Card key={`b${i}`} t={t} clone />
      ))}
    </div>
  );
}

/// The reaction to the app, as two marquees running opposite ways. Hand-rolled
/// cards rather than embeds — see src/lib/testimonials.ts for why.
///
/// Two rows, not one: seven quotes in a single row is a long wait for the one
/// at the back, and a second row moving the other way is also what stops the
/// pair reading as one belt sliding the page sideways.
///
/// The fade is a `mask-image` on the clipping element rather than two gradient
/// overlays: an overlay has to name the page's own background to fake a fade,
/// which is a second place the background colour is written down.
export function Testimonials({ className }: { className?: string }) {
  if (TESTIMONIALS.length === 0) return null;

  const half = Math.ceil(TESTIMONIALS.length / 2);
  const top = TESTIMONIALS.slice(0, half);
  const bottom = TESTIMONIALS.slice(half);

  return (
    <section className={className}>
      <h2 className="mb-4 font-mono text-xs tracking-wide text-muted-foreground uppercase">
        From X
      </h2>
      <div className="flex flex-col gap-3 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
        <Row run={[...top, ...top]} />
        <Row run={[...bottom, ...bottom]} reverse />
      </div>
    </section>
  );
}

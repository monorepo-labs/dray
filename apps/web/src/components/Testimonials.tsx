import { byHandle, type Testimonial } from "@/lib/testimonials";

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
function Card({ t }: { t: Testimonial }) {
  return (
    <a
      href={t.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-xl border border-border/50 p-5 transition-colors hover:border-card hover:bg-card"
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
        {/* `whitespace-pre-line` because a post can have a blank line in it,
            and without it the paragraphs run together into one sentence that
            nobody wrote. Spaces still collapse, so the indented string in
            testimonials.ts is unaffected. */}
        <blockquote className="mt-2.5 text-base leading-normal break-words whitespace-pre-line text-pretty sm:text-lg">
          {t.text}
        </blockquote>
      </figure>
    </a>
  );
}

/// The pair of quotes that sits under one feature.
///
/// Takes however many handles it is given rather than exactly two: the count
/// is an editorial decision and belongs in features.ts, where the pairs are
/// actually chosen.
///
/// **Not a wall any more.** They were a block of six above the footer, and
/// before that two marquees running opposite ways. A wall is a pile a reader
/// scrolls past once; put under the feature it is about, the same sentence is
/// somebody agreeing with the claim directly above it.
///
/// Which is why the pairing lives on the feature ([`Feature.quotes`]) and not
/// here: what a quote is evidence *for* is a fact about the feature, not about
/// the post.
///
/// Two columns, which is also what keeps a four-word reaction from stretching
/// across the whole text column and reading as a mistake. One column on a
/// phone, where half of it is about 150px of text.
///
/// A grid rather than the CSS columns the old wall used: a pair reads as a
/// pair when both start on the same line, and columns would stack the second
/// under the first.
export function Quotes({
  handles,
  className,
}: {
  handles: string[];
  className?: string;
}) {
  const quotes = handles.map(byHandle).filter((t) => t !== undefined);
  if (quotes.length === 0) return null;

  return (
    <div className={`grid gap-3 sm:grid-cols-2 ${className ?? ""}`}>
      {quotes.map((t) => (
        <Card key={t.url} t={t} />
      ))}
    </div>
  );
}

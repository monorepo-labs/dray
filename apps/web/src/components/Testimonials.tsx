import { XGlyph } from "@/components/XGlyph";
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

/// One post. Hand-rolled cards rather than embeds — see src/lib/testimonials.ts
/// for why the syndication API can't serve these.
///
/// **Compact and unfilled** — a hairline, 32px avatar, name and handle stacked
/// tight, X's mark at the corner saying where it came from. A filled card
/// with a shadow was tried and came off: that is the page's language for a
/// piece of the app, and a quote is not one.
///
/// The whole card is the link, which is also why nothing inside it is one. No
/// hover state: a quote lifting under the cursor read as a control, and the
/// mark in the corner already says it goes somewhere.
function Card({ t }: { t: Testimonial }) {
  return (
    <a
      href={t.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block break-inside-avoid rounded-xl border border-border/50 p-6"
    >
      <figure>
        <figcaption className="flex items-center gap-3">
          {t.avatar ? (
            // Plain `img`, not `next/image`: these are 40px avatars whose files
            // are already small, so the optimizer's round trip buys nothing and
            // costs a required width/height pair per card.
            <img
              src={t.avatar}
              alt=""
              width={40}
              height={40}
              className="size-10 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-sm font-medium text-muted-foreground"
            >
              {t.name.charAt(0)}
            </span>
          )}
          {/* `min-w-0` on the wrapper is what lets the two truncations below
              actually fire: a flex child defaults to its content's width, so a
              long handle would push the card wide instead. */}
          <span className="min-w-0 leading-tight">
            <span className="flex items-center gap-1 text-base font-medium">
              <span className="truncate">{t.name}</span>
              {t.verified && <VerifiedGlyph className="size-4 shrink-0" />}
            </span>
            <span className="block truncate text-sm text-muted-foreground">
              @{t.handle}
            </span>
          </span>
          <XGlyph className="ml-auto size-4 shrink-0 self-start text-muted-foreground/60" />
        </figcaption>
        {/* `whitespace-pre-line` because a post can have a blank line in it,
            and without it the paragraphs run together into one sentence that
            nobody wrote. Spaces still collapse, so the indented string in
            testimonials.ts is unaffected. */}
        <blockquote className="mt-4 text-lg leading-normal break-words whitespace-pre-line text-pretty sm:text-xl">
          {t.text}
        </blockquote>
      </figure>
    </a>
  );
}

/// Every post, as one section after the features. They sat in pairs under
/// each feature for a while, as evidence for the claim above them; that
/// spread ten short reactions thinly down a long page and left the features
/// with the most to show carrying none. One section reads as what it is —
/// people liking the thing — and the drawings above it carry the claims.
///
/// CSS columns rather than a grid, since a four-word reaction beside a
/// paragraph leaves a grid row mostly empty; columns pack them. Two, not
/// three: at three a card is narrower than a sentence and the type had to
/// shrink to fit, which made the whole section read as small print.
export function Testimonials({ className }: { className?: string }) {
  return (
    <section className={className}>
      <h2 className="mb-6 max-w-2xl font-display text-3xl leading-[1.1] font-medium tracking-tight text-balance sm:mb-8 sm:text-4xl">
        Loved by people who run agents all day.
      </h2>
      <div className="gap-4 space-y-4 sm:columns-2">
        {TESTIMONIALS.map((t) => (
          <Card key={t.url} t={t} />
        ))}
      </div>
    </section>
  );
}

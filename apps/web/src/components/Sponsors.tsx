import { ArrowUpRight } from "lucide-react";

import { GreptileGlyph } from "@/components/GreptileGlyph";
import { SponsorLink } from "@/components/SponsorLink";
import { SPONSOR } from "@/lib/links";

/// Who pays for this. A grant is money and an OSS programme handing over
/// credits is not, so each name carries its own line saying which — "OSS
/// Grants" against "AI code reviews, free for open source" — rather than one
/// row implying both wrote a cheque.
///
/// That line does it by naming the *work*, not the arrangement: saying what
/// the credits buy is both specific and a fact about how the repo is run.
///
/// A heading over a row, centred, with room around it. It sat in a strip
/// with the label to one side, and between the hero window and the first
/// feature it read as a caption to whichever was nearer; the heading gives
/// it a top edge and the margins give it a section's worth of air.
///
/// Deliberately not a list in `lib/` — two entries drawn two different ways
/// (an avatar, a mark) have no shape worth sharing.
export function Sponsors({ className }: { className?: string }) {
  return (
    <section className={`flex flex-col items-center text-center ${className ?? ""}`}>
      <h2 className="mb-6 font-display text-xl leading-tight font-medium tracking-tight text-balance sm:text-2xl">
        Supported by
      </h2>

      <div className="grid w-full gap-6 sm:grid-cols-2">
        {/* "Vercel CEO" is who he is, not who is paying — the grant is his own
            programme and Vercel is nowhere in it. It earns the line anyway,
            since the name alone means nothing to a reader who doesn't follow
            him, and a credit nobody can place says nothing.

            Two links, because they answer two questions: the name goes to the
            person, the programme goes to the programme. Both on one anchor
            meant whichever it pointed at was wrong for half the readers. */}
        <Entry
          mark={
            // Plain `img` for the same reason the testimonial avatars are: at
            // this size the optimizer's round trip buys nothing.
            <img
              src="/avatars/rauchg.jpg"
              alt=""
              width={40}
              height={40}
              className="size-10 shrink-0 rounded-full object-cover"
            />
          }
          name={
            <Credit href="https://x.com/rauchg" sponsor="guillermo_rauch" destination="profile">
              Guillermo Rauch
            </Credit>
          }
          note={
            <>
              Vercel CEO ·{" "}
              <NoteLink
                href="https://rauchg-oss-grants.vercel.app/"
                sponsor="guillermo_rauch"
                destination="oss_grants"
              >
                OSS Grants
              </NoteLink>
            </>
          }
        />

        {/* The note carries what the label used to say. Dropping "AI code
            reviews by" and leaving "Free for open source" alone would credit
            Greptile for nothing in particular — only this line says what this
            one does. */}
        <Entry
          mark={
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-card">
              <GreptileGlyph className="size-5" />
            </span>
          }
          name={
            <Credit href="https://www.greptile.com/" sponsor="greptile" destination="website">
              Greptile
            </Credit>
          }
          note="AI code reviews, free for open source"
        />
      </div>

      {/* The way in for the next name. One quiet line under the two rather
          than a button beside them: the section credits, it does not ask. */}
      <a
        href={SPONSOR}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 inline-flex items-center gap-0.5 text-sm text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
      >
        Support the project
        <ArrowUpRight className="size-3.5" aria-hidden />
      </a>
    </section>
  );
}

/// A mark, a name, and one line under it saying what they gave. Not itself
/// a link, since the name and the note point at different places and an
/// anchor cannot hold another.
function Entry({
  mark,
  name,
  note,
}: {
  mark: React.ReactNode;
  name: React.ReactNode;
  note: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-center gap-3 text-left">
      {mark}
      <div className="min-w-0 leading-tight">
        <div className="text-base font-medium sm:text-lg">{name}</div>
        <p className="mt-0.5 text-sm text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}

/// The name. Full strength, since it is what the row is for; hover dims
/// rather than brightens, there being nowhere brighter to go.
function Credit({
  href,
  sponsor,
  destination,
  children,
}: {
  href: string;
  sponsor: string;
  destination: string;
  children: React.ReactNode;
}) {
  return (
    <SponsorLink
      href={href}
      sponsor={sponsor}
      destination={destination}
      className="transition-opacity hover:opacity-70"
    >
      {children}
    </SponsorLink>
  );
}

/// A link inside a note. Underlined, since at this size and weight a colour
/// change is the only other signal and the note is already the quiet line.
function NoteLink({
  href,
  sponsor,
  destination,
  children,
}: {
  href: string;
  sponsor: string;
  destination: string;
  children: React.ReactNode;
}) {
  return (
    <SponsorLink
      href={href}
      sponsor={sponsor}
      destination={destination}
      className="underline underline-offset-2 transition-colors hover:text-foreground"
    >
      {children}
    </SponsorLink>
  );
}

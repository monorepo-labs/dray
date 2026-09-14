import { GreptileGlyph } from "@/components/GreptileGlyph";

/// Who pays for this. A grant is money and an OSS programme handing over
/// credits is not, so each name carries its own line saying which — "OSS
/// Grants" against "AI code reviews, free for open source" — rather than one
/// row implying both wrote a cheque.
///
/// That line does it by naming the *work*, not the arrangement. "Supported
/// by" is a phrase that could cover anything, where saying what the credits
/// buy is both specific and a fact about how the repo is run.
///
/// Centred where the rest of the page is left-aligned, since it sits alone
/// between the hero capture and the features and reads as a caption to the
/// pitch rather than as the next section down.
///
/// Deliberately not a list in `lib/` — two entries drawn two different ways
/// (an avatar, a mark) have no shape worth sharing.
export function Sponsors({ className }: { className?: string }) {
  return (
    <section className={`text-center ${className ?? ""}`}>
      {/* The heading says who these two are, not what their money buys.
          It read "Dray stays free and open source thanks to its sponsors",
          which is not true — Dray was always free and stays free either way,
          and a credit line that overstates itself is worth less than none.
          What the names are actually doing here is vouching.

          It sat under the names for a moment and came back: the names are
          full-strength and the largest thing here now, so they hold the eye
          from either position — which leaves this free to go where a heading
          goes and be read first.

          Styled as the page's section headings are: mono, medium, tight,
          full-strength. It was `text-sm text-muted-foreground`, which made it
          smaller and quieter than the two names beneath it and read as a
          footnote that had floated to the top. */}
      <h2 className="mb-8 font-mono text-base leading-tight font-medium tracking-tight text-balance sm:text-lg">
        Supported by the best in the business.
      </h2>

      <div className="flex flex-col items-center gap-8 sm:flex-row sm:justify-center sm:gap-16">
        {/* "Vercel CEO" is who he is, not who is paying — the grant is his
            own programme and Vercel is nowhere in it. It earns the line
            anyway, since the name alone means nothing to a reader who doesn't
            follow him, and a credit nobody can place says nothing.

            Two links, because they answer two questions: the name goes to the
            person, the programme goes to the programme. Both on one anchor
            meant whichever it pointed at was wrong for half the readers. */}
        <Group
          note={
            <>
              Vercel CEO ·{" "}
              <NoteLink href="https://rauchg-oss-grants.vercel.app/">
                OSS Grants
              </NoteLink>
            </>
          }
        >
          <Credit href="https://x.com/rauchg" name="Guillermo Rauch">
            {/* Plain `img` for the same reason the testimonial avatars are: at
                this size the optimizer's round trip buys nothing. */}
            <img
              src="/avatars/rauchg.jpg"
              alt=""
              width={28}
              height={28}
              className="size-7 shrink-0 rounded-full object-cover"
            />
          </Credit>
        </Group>

        {/* The note carries what the label used to say. Dropping "AI code
            reviews by" and leaving "Free for open source" alone would credit
            Greptile for nothing in particular — the heading calls both of
            these sponsors, and only this line says what this one does. */}
        <Group note="AI code reviews, free for open source">
          <Credit href="https://www.greptile.com/" name="Greptile">
            <GreptileGlyph className="h-6 w-auto shrink-0" />
          </Credit>
        </Group>
      </div>

    </section>
  );
}

/// A name with one line under it saying what they gave.
///
/// There were mono uppercase labels over each name — "Sponsored by", "AI code
/// reviews by" — and with the heading above saying the word "sponsors" and
/// the note below saying what each one does, they were a third label on a
/// two-item list. `note` now carries whatever they said that the heading and
/// the name do not.
function Group({
  note,
  children,
}: {
  note: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      {/* Fixed height, so the two groups are the same height and the two notes
          under them share a baseline. Left to the content, a 28px avatar
          beside a 24px mark makes one group taller and `items-center` then
          sets those lines a couple of pixels apart, close enough to read as a
          mistake rather than as a choice. */}
      <div className="flex h-7 items-center justify-center">{children}</div>
      {/* `text-sm text-muted-foreground` and nothing cleverer — it is the
          register the licence line and the footer already use, where the 12px
          at 60% opacity this was before is a value nothing else on the page
          reaches for, and read as a caption apologising for being there. */}
      <p className="mt-2 text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

function Credit({
  href,
  name,
  children,
}: {
  href: string;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Full-strength text, and the largest thing in the section: these two
      // names are what it is for, and in muted grey at 14px they read as
      // small print somebody added at the bottom of a page.
      //
      // Which leaves nowhere brighter for hover to go, so it dims instead —
      // on opacity rather than colour, since that carries the avatar and the
      // mark along with the words.
      className="flex items-center gap-2.5 text-base font-medium transition-opacity hover:opacity-70 sm:text-lg"
    >
      {children}
      {name}
    </a>
  );
}

/// A link inside a note. Underlined, since at this size and weight a colour
/// change is the only other signal and the note is already the quiet line.
function NoteLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 transition-colors hover:text-foreground"
    >
      {children}
    </a>
  );
}

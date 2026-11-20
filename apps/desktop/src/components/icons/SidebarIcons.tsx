import { useId } from "react";

/// The sidebar strip's own filled glyphs, on a 16px grid. A cut-out (the plus,
/// the eyes) is a mask rather than a second colour, so the glyph stays one
/// `currentColor` shape over any row fill.
function Filled({ shape, cut, className }: { shape: React.ReactNode; cut?: React.ReactNode; className?: string }) {
  const id = useId();
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" className={className}>
      {cut && (
        <mask id={id}>
          <rect width="16" height="16" fill="#fff" />
          {cut}
        </mask>
      )}
      <g fill="currentColor" mask={cut ? `url(#${id})` : undefined}>
        {shape}
      </g>
    </svg>
  );
}

const cut = (d: string) => (
  <path d={d} fill="none" stroke="#000" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
);

/// New Task: a rounded square with a plus knocked out.
export function NewTaskIcon({ className }: { className?: string }) {
  return <Filled className={className} shape={<rect x="1.5" y="1.5" width="13" height="13" rx="4" />} cut={cut("M8 5v6M5 8h6")} />;
}

/// Issues: a flag on its pole.
export function IssuesIcon({ className }: { className?: string }) {
  return (
    <Filled
      className={className}
      shape={
        <>
          <path d="M3 2.5a.75.75 0 0 1 1.5 0v11.25a.75.75 0 0 1-1.5 0z" />
          <path d="M4.5 2.25h7.9a.6.6 0 0 1 .5.9l-1.6 2.75 1.6 2.75a.6.6 0 0 1-.5.9H4.5z" />
        </>
      }
    />
  );
}

/// Pull requests: a branch reaching back into the line it came from.
export function PullsIcon({ className }: { className?: string }) {
  return (
    <Filled
      className={className}
      shape={
        <>
          <circle cx="4.5" cy="3.5" r="2" />
          <circle cx="4.5" cy="12.5" r="2" />
          <circle cx="11.5" cy="12.5" r="2" />
          <path d="M4.5 5.5v5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
          <path d="M11.5 10.5V7a2.5 2.5 0 0 0-2.5-2.5H7.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 3 7.5 4.5 9 6" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </>
      }
    />
  );
}

/// New bot: a face, two eyes knocked out of a soft square.
export function NewBotIcon({ className }: { className?: string }) {
  return (
    <Filled
      className={className}
      shape={<rect x="1.75" y="2.25" width="12.5" height="11.5" rx="5" />}
      cut={cut("M6.25 6.9v2M9.75 6.9v2")}
    />
  );
}

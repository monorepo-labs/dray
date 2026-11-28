import { sides, type PickedElement } from "@/lib/canvas";
import { cn } from "@/lib/utils";

const px = (v: string) => v.replace(/px$/, "");
const round = (n: number) => String(Math.round(n * 100) / 100);
const clear = (c: string) => c === "transparent" || c === "rgba(0, 0, 0, 0)";

/// The inspect panel: what a design tool shows about a picked layer, read
/// off the browser's computed style. Read-only in v1: changes are asked of the
/// agent, which the pick in the composer is for.
export default function StylePanel({ selection, frame }: { selection: PickedElement | null; frame: string | null }) {
  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-border/60 select-text">
      {!selection ? (
        <div className="flex flex-col gap-2 p-3 text-ui text-muted-foreground">
          <p className="font-medium text-foreground">Inspect</p>
          <p>Click an element in a frame to see its styles. The pick goes into the chat, with its source line, for the agent to change.</p>
          <p>Shift-click adds another. Space and drag pans; pinch or ⌘ and scroll zooms.</p>
        </div>
      ) : (
        <Body el={selection} frame={frame} />
      )}
    </aside>
  );
}

function Body({ el, frame }: { el: PickedElement; frame: string | null }) {
  const s = el.styles;
  const border = sides(s.borderWidth);
  const radius = sides(s.borderRadius);
  return (
    <>
      <Section>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[12px] font-medium">&lt;{el.tag}&gt;</span>
          {el.components.length > 0 && (
            <span className="min-w-0 truncate text-ui text-muted-foreground">{el.components.join(" › ")}</span>
          )}
        </div>
        {el.source && (
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={el.source}>
            {el.source}
            {!el.sourceIsOwn && " (parent)"}
          </p>
        )}
        {frame && <p className="text-[11px] text-muted-foreground">In {frame} · added to the chat</p>}
      </Section>

      <Section title="Layout">
        <Grid>
          <Field label="W" value={round(el.rect.width)} />
          <Field label="H" value={round(el.rect.height)} />
          <Field label="Display" value={s.display} wide />
          {s.flexDirection && <Field label="Direction" value={s.flexDirection} wide />}
          {s.gap && s.gap !== "normal" && <Field label="Gap" value={px(s.gap)} />}
        </Grid>
      </Section>

      <Section title="Spacing">
        <BoxModel margin={s.margin} padding={s.padding} size={`${round(el.rect.width)} × ${round(el.rect.height)}`} />
      </Section>

      <Section title="Border">
        <Grid>
          <Field label="Width" value={border === "0px" ? "0" : px(border)} />
          <Field label="Radius" value={px(radius)} />
          {border !== "0px" && (
            <>
              <Field label="Style" value={s.borderStyle} />
              <Colour label="Colour" value={s.borderColor} />
            </>
          )}
        </Grid>
      </Section>

      <Section title="Typography">
        <Field label="Font" value={s.fontFamily.split(",")[0].replace(/["']/g, "")} wide />
        <Grid>
          <Field label="Size" value={px(s.fontSize)} />
          <Field label="Weight" value={s.fontWeight} />
          <Field label="Line" value={s.lineHeight === "normal" ? "auto" : px(s.lineHeight)} />
          <Field label="Letter" value={s.letterSpacing === "normal" ? "0" : px(s.letterSpacing)} />
          <Field label="Align" value={s.textAlign} />
        </Grid>
      </Section>

      <Section title="Fill">
        <Colour label="Text" value={s.color} />
        <Colour label="Background" value={s.background} />
        {s.opacity !== "1" && <Field label="Opacity" value={s.opacity} />}
        {s.boxShadow !== "none" && <Field label="Shadow" value={s.boxShadow} wide />}
      </Section>

      {el.classes && (
        <Section title="Classes">
          <p className="font-mono text-[11px] leading-4 break-words text-muted-foreground">{el.classes}</p>
        </Section>
      )}
    </>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-border/60 px-3 py-2.5">
      {title && <h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>}
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-1.5">{children}</div>;
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div
      className={cn("flex h-6 min-w-0 items-center gap-1.5 rounded-md bg-foreground/[0.045] px-1.5 text-ui", wide && "col-span-2")}
      title={value}
    >
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate tabular-nums">{value}</span>
    </div>
  );
}

function Colour({ label, value }: { label: string; value: string }) {
  return (
    <div className="col-span-2 flex h-6 min-w-0 items-center gap-1.5 rounded-md bg-foreground/[0.045] px-1.5 text-ui" title={value}>
      <span
        className={cn("size-3.5 shrink-0 rounded-[4px] ring-1 ring-black/10", clear(value) && "bg-[repeating-conic-gradient(#ddd_0_25%,#fff_0_50%)] bg-[length:6px_6px]")}
        style={clear(value) ? undefined : { background: value }}
      />
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate tabular-nums">{clear(value) ? "none" : value}</span>
    </div>
  );
}

/// Margin around padding around the box, each side's number on its side, the
/// way browser dev tools and design tools both draw it.
function BoxModel({ margin, padding, size }: { margin: string[]; padding: string[]; size: string }) {
  const n = (v: string) => (px(v) === "0" ? "–" : px(v));
  return (
    <div className="relative rounded-md border border-dashed border-border px-6 py-4 text-center text-[11px] tabular-nums">
      <span className="absolute top-0.5 left-1.5 text-[10px] text-muted-foreground">margin</span>
      <Sides values={margin.map(n)} />
      <div className="relative rounded-sm border border-[#0d99ff]/40 bg-[#0d99ff]/[0.06] px-6 py-4">
        <span className="absolute top-0.5 left-1.5 text-[10px] text-muted-foreground">padding</span>
        <Sides values={padding.map(n)} />
        <div className="rounded-[3px] bg-foreground/[0.06] px-1 py-1 text-[11px]">{size}</div>
      </div>
    </div>
  );
}

function Sides({ values: [t, r, b, l] }: { values: string[] }) {
  return (
    <>
      <span className="absolute top-0.5 left-1/2 -translate-x-1/2">{t}</span>
      <span className="absolute top-1/2 right-1.5 -translate-y-1/2">{r}</span>
      <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2">{b}</span>
      <span className="absolute top-1/2 left-1.5 -translate-y-1/2">{l}</span>
    </>
  );
}

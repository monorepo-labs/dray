import { Section, Title } from "@/components/home/Section";
import { TESTIMONIALS } from "@/lib/testimonials";

/// What people said on X, as a 4×2 wall of cards each linking to its post.
export function Testimonials() {
  return (
    <Section id="testimonials" className="py-20">
      <Title lead="What devs">
        running agents days, nights and weekends <span className="text-white light:text-[#0A0A0A]">are saying.</span>
      </Title>
      <div className="mt-12 grid gap-px sm:grid-cols-2 lg:mt-20 lg:grid-cols-4">
        {TESTIMONIALS.map((t) => (
          <a
            key={t.url}
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[140px] flex-col sm:min-h-[180px] justify-between gap-6 bg-[#FFFFFF1A] p-6 transition-colors hover:bg-[#FFFFFF24] light:bg-[#F4F4F5] light:hover:bg-[#EBEBEB] lg:h-[220px]"
          >
            <blockquote className="text-[17px] leading-6 tracking-[-0.01em] text-white light:text-[#0A0A0A]">{t.text}</blockquote>
            <span className="flex items-center gap-2.5">
              {t.avatar ? (
                <img src={t.avatar} alt="" width={28} height={28} className="size-7 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10 text-xs light:bg-black/10">{t.name.charAt(0)}</span>
              )}
              <span className="truncate text-[13px] leading-4 text-[#8A8A8A] light:text-[#6B6B6B]">{t.name}</span>
            </span>
          </a>
        ))}
      </div>
    </Section>
  );
}

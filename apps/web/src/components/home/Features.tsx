import type { ReactNode } from "react";

import { GitHubGlyph } from "@/components/GitHubGlyph";
import { LinearGlyph } from "@/components/LinearGlyph";
import { Section, Title } from "@/components/home/Section";

/// Ticket, PR and browser: three hairline columns, each a small drawn mock over its caption.
export function Features() {
  return (
    <Section id="features" className="py-20">
      <Title lead="Ticket to merge, all in app.">Issues, diffs, files, PRs and a browser right beside the chat.</Title>
      <div className="mt-12 grid divide-y divide-[#FFFFFF26] border border-[#FFFFFF26] light:divide-black/10 light:border-black/10 lg:mt-20 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <Column
          art={<Issues />}
          title="Start from a ticket."
          body={
            <>
              Pick up a <Mark>GitHub</Mark> or <Mark>Linear</Mark> issue. It stays linked to the chat.
            </>
          }
        />
        <Column art={<PullRequest />} title="Review and merge here." body="Your pull request's checks and comments sit right beside the chat." />
        <Column art={<Browser />} title="Test it right in Dray." body="Open your dev server in the built-in browser. Your agent tests in it too." />
      </div>
    </Section>
  );
}

function Column({ art, title, body }: { art: ReactNode; title: string; body: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex h-[220px] shrink-0 flex-col justify-center overflow-clip bg-[#FFFFFF1A] p-6 light:bg-[#F4F4F5]">{art}</div>
      <div className="flex flex-col gap-2 border-t border-[#FFFFFF26] p-6 light:border-black/10">
        <h3 className="text-xl leading-[26px] tracking-[-0.02em] text-white light:text-[#0A0A0A]">{title}</h3>
        <p className="text-[15px] leading-[22px] text-[#8A8A8A] light:text-[#6B6B6B]">{body}</p>
      </div>
    </div>
  );
}

function Mark({ children }: { children: ReactNode }) {
  return <mark className="bg-[#FFE14D] px-[3px] text-[#0B0B0F]">{children}</mark>;
}

function IssueRow({ id, title, selected }: { id: string; title: string; selected?: boolean }) {
  return (
    <div className={`flex h-[34px] shrink-0 items-center gap-2.5 px-2.5 ${selected ? "bg-[#1612F8]" : ""}`}>
      {selected ? <GitHubGlyph className="size-3 shrink-0 text-white" /> : <LinearGlyph className="size-3 shrink-0 text-[#8A8A8A]" />}
      <span className={`w-12 shrink-0 font-mono text-[10px] leading-3 tracking-[-0.04em] ${selected ? "text-[#FFFFFFB3]" : "text-[#8A8A8A]"}`}>
        {id}
      </span>
      <span className={`font-mono text-xs leading-4 tracking-[-0.04em] ${selected ? "text-white" : "text-[#CFCFCF] light:text-[#3F3F46]"}`}>{title}</span>
    </div>
  );
}

function Issues() {
  return (
    <div aria-hidden className="flex flex-col bg-[#0A0A0A] light:bg-white light:shadow-[0_0_0_1px_#0000000F]">
      <IssueRow id="DRA-53" title="Add issue tracker" />
      <IssueRow id="dray#255" title="Paste images" selected />
      <IssueRow id="DRA-61" title="Retry uploads" />
    </div>
  );
}

function PullRequest() {
  return (
    <div aria-hidden className="flex flex-col bg-[#0A0A0A] light:bg-white light:shadow-[0_0_0_1px_#0000000F]">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0">
          <path
            d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z"
            fill="#3FB950"
            className="light:fill-[#1A7F37]"
          />
        </svg>
        <span className="font-mono text-xs leading-4 tracking-[-0.04em] text-white light:text-[#0A0A0A]">Fix login loop</span>
        <span className="ml-auto font-mono text-[11px] leading-[14px] tracking-[-0.04em] text-[#3FB950] light:text-[#1A7F37]">
          +128 <span className="text-[#F85149] light:text-[#CF222E]">−42</span>
        </span>
      </div>
      <div className="flex h-11 shrink-0 items-center justify-between border-t border-[#FFFFFF14] px-3 light:border-black/10">
        <span className="font-mono text-[11px] leading-[14px] tracking-[-0.04em] text-[#3FB950] light:text-[#1A7F37]">✓ Checks passed</span>
        <span className="flex h-[26px] items-center bg-[#238636] px-3 text-xs leading-4 font-medium text-white">Merge</span>
      </div>
    </div>
  );
}

function Browser() {
  return (
    <div aria-hidden className="flex h-[172px] shrink-0 flex-col bg-[#0A0A0A] light:bg-white light:shadow-[0_0_0_1px_#0000000F]">
      <div className="flex h-6 shrink-0 items-center gap-1.5 bg-[#161616] px-2 light:bg-[#EDEDF0]">
        <span className="size-[5px] shrink-0 rounded-[3px] bg-[#3D3D3D] light:bg-[#C7C7CD]" />
        <span className="size-[5px] shrink-0 rounded-[3px] bg-[#3D3D3D] light:bg-[#C7C7CD]" />
        <span className="flex h-3.5 w-[130px] shrink-0 items-center bg-[#0A0A0A] px-1.5 font-mono text-[9px] light:bg-white leading-3 tracking-[-0.04em] text-[#8A8A8A]">
          localhost:5173
        </span>
      </div>
      <div className="flex flex-1 gap-3.5 p-3.5">
        <div className="relative flex w-30 shrink-0 flex-col gap-2.5">
          <div className="h-2.5 w-24 shrink-0 bg-[#3D3D3D] light:bg-[#D6D6DB]" />
          <div className="h-1.5 w-18 shrink-0 bg-[#262626] light:bg-[#E4E4E7]" />
          <div className="mt-5 h-[22px] w-18 shrink-0 bg-[#9A9A9A] light:bg-[#3F3F46]" />
          <div className="absolute top-11 left-44 flex items-start gap-0.5">
            <svg width="14" height="16" viewBox="0 0 12 16" className="shrink-0">
              <path d="M1 1 L1 13 L4.5 9.8 L7 15 L9 14 L6.6 9 L11 9 Z" fill="#FFFFFF" stroke="#000000" />
            </svg>
            <span className="mt-3 flex h-[18px] items-center bg-white px-1.5 light:bg-[#0A0A0A] light:text-white font-mono text-[9px] leading-3 tracking-[-0.02em] text-[#0B0B0F]">
              You
            </span>
          </div>
          <div className="absolute top-15 left-8 size-6 rounded-xl border-2 border-[#1612F8] bg-[#1612F84D]" />
          <span className="absolute top-19 left-15 flex h-[18px] items-center bg-[#1612F8] px-1.5 font-mono text-[9px] leading-3 tracking-[-0.02em] text-white">
            Agent
          </span>
        </div>
        <div className="flex flex-1 flex-col">
          <div className="h-24 shrink-0 bg-[#141414] light:bg-[#F4F4F5]" />
        </div>
      </div>
    </div>
  );
}

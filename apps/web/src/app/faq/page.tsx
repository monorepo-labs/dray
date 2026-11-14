import type { Metadata } from "next";

import { Closing } from "@/components/home/Closing";
import { FaqItem } from "@/components/faq/FaqItem";
import { SiteNav } from "@/components/home/SiteNav";
import { type FaqEntry, faqSchema } from "@/lib/faq";

export const metadata: Metadata = {
  title: "FAQ - Dray",
  description: "How Dray's bots run your coding tasks, which agents and subscriptions it uses, and where your data lives.",
};

const LABEL = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase";

// Each answer is checked against the app, not the plan: a question here
// promising a feature is a bug report waiting to happen.
const GROUPS: { title: string; entries: FaqEntry[] }[] = [
  {
    title: "Bots",
    entries: [
      {
        q: "What is a bot?",
        a: "A bot is one ongoing chat that runs your coding tasks. Tell it what you want and it starts a task for each piece of work, keeps track of them all, and tells you how they went. Each task is its own agent session in its own git worktree, kept out of your sidebar.",
      },
      {
        q: "Do I have to set one up?",
        a: "No. Dray comes with Dray Bot, ready to chat. To make another, click New bot in the sidebar and pick a name, a face, and the agent and model it runs on. Tell it its job in your first message and it writes that down itself.",
      },
      {
        q: "Which repos can a bot work in?",
        a: "Any of them. A bot belongs to no project. It picks the repo for each task, even one you never added to Dray, and can start a task on another of your machines.",
      },
      {
        q: "How does my message reach the right task?",
        a: "The bot reads it and passes it on to the task it is about, with the context that task needs. To name a task yourself, type & in the bot's chat and pick one of its active tasks.",
      },
      {
        q: "How do I know what my tasks are doing?",
        a: "Every task reports back to the bot when its turn ends. Dray sends that report, not the agent, so a task can't forget to. The bot then tells you what matters, in a line or two, and stays quiet when nothing needs you.",
      },
      {
        q: "What shows up as waiting on me?",
        a: "A task that has sat for five minutes on a question for you, and a pull request ready to merge. They show at the foot of the bot's chat, and Dray sends a desktop notification when the window is in the background. Failing checks, merge conflicts and requested changes go to the bot instead, which has the task fix them.",
      },
      {
        q: "How do I merge a task's pull request?",
        a: "When GitHub says the pull request is ready, a merge card appears in the bot's chat. Merge from it and Dray merges the pull request, settles the task and deletes its worktree. The same Merge button sits on the task's row in the Tasks tab.",
      },
      {
        q: "Do tasks' questions and permission requests reach me?",
        a: "Yes. When a task asks you something or wants permission to run a tool, the card comes to you in the bot's chat, so you answer without leaving it.",
      },
      {
        q: "Can I look inside a task?",
        a: "Yes. Click it in the side panel's Tasks tab, or on the line where the bot started it, and it opens as a tab next to the bot's chat with its own transcript, composer, diff, files and browser.",
      },
      {
        q: "Does a bot remember how I work?",
        a: "Yes. A bot saves what it learns, such as your preferences, decisions, people and where things live, as notes in its own folder, and reads them when they matter. Its instructions file holds its job and your rules. Dray commits that folder to a local git history after every turn, so nothing the bot overwrites is lost.",
      },
      {
        q: "Can I switch a bot to another agent?",
        a: "Yes, between turns. Pick another agent in the bot's model picker and your next message moves the chat over. The new agent is handed the conversation so far, and the tasks already running carry on.",
      },
      {
        q: "Can I have more than one bot?",
        a: "Yes. Make one per job, such as one for ops and one for a side project. Bots can message each other: type @ in a bot's chat to name another one.",
      },
      {
        q: "Can I still run sessions without a bot?",
        a: "Yes. Start a session from the sidebar and drive the agent yourself, as before.",
      },
    ],
  },
  {
    title: "Agents and subscriptions",
    entries: [
      {
        q: "Which agents does Dray support?",
        a: "Claude Code, Codex, pi, fx and Grok Build. Each session and each bot picks its own agent and model, so you can run several side by side.",
        link: { label: "Compare the agents", href: "/docs/using-dray/agents" },
      },
      {
        q: "Do I need a new subscription or API key?",
        a: "No. Bring your own. Dray runs each agent's own CLI, signed in the way you already use it, so your work runs on the subscription or key that agent already has. Dray stores no agent login and charges nothing.",
      },
      {
        q: "Is Dray safe to use with my Claude subscription?",
        a: "Yes. Dray runs Anthropic's own Claude Code CLI so it works within their terms.",
      },
      {
        q: "Does Dray install the agents for me?",
        a: "No. Install each agent the way its maker says. If one is missing, Dray's agent picker marks it and gives you the command to install it.",
        link: { label: "Install an agent", href: "/docs/get-started/install#install-an-agent" },
      },
    ],
  },
  {
    title: "Machines and privacy",
    entries: [
      {
        q: "Does Dray send my code off my machine?",
        a: "No. Your sessions, transcripts and bot notes stay on your machine, and your agents talk to their own providers, as usual. Dray sends a few anonymous usage events, never your prompts or code, and DRAY_NO_ANALYTICS turns them off.",
        link: { label: "What Dray sends", href: "/docs/reference/privacy" },
      },
      {
        q: "Do my sessions keep running when I quit Dray?",
        a: "Yes. On a Mac your sessions run in a background server, so quitting the app leaves them working. Choose Quit completely to stop them too.",
      },
      {
        q: "Can I run agents on my other machines?",
        a: "Yes. Install the Dray server on a Linux box or another Mac and add it in Dray. Its sessions show in the same sidebar, and a bot can send tasks there.",
        link: { label: "Set up a server", href: "/docs/server" },
      },
      {
        q: "Does Dray run on Linux?",
        a: "Yes, as a server. Your agents run on Linux, and you drive them from the Dray app on your Mac.",
      },
    ],
  },
  {
    title: "General",
    entries: [
      {
        q: "What is Dray?",
        a: "Dray is a Mac app for coding agents. Talk to one bot that runs many tasks for you, or drive sessions yourself, on your Mac or on your other machines.",
      },
      {
        q: "Is Dray free?",
        a: "Yes. Dray is free and open source under Apache 2.0.",
      },
      {
        q: "What do I need to run it?",
        a: "A Mac on macOS 11 or later, and at least one of the supported agents installed and signed in.",
      },
    ],
  },
];

/// Every question the homepage has no room for, grouped, as the homepage
/// FAQ's own disclosures.
export default function FaqPage() {
  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqSchema(GROUPS.flatMap((g) => g.entries)) }} />
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />

          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className="pt-16 font-inter text-[28px] leading-[32px] font-normal tracking-[-0.03em] text-balance sm:pt-[101px] sm:text-[36px] sm:leading-[40px]">
              Frequently Asked Questions
            </h1>
            <p className="mt-4 text-[16px] leading-6 tracking-[-0.01em] text-[#7C7C7C] light:text-[#8A8A8A]">
              Bots, agents, subscriptions and where your data lives.
            </p>

            <div className="mt-16 space-y-14">
              {GROUPS.map((g) => (
                <section key={g.title} id={g.title.toLowerCase().replace(/\s+/g, "-")} className="scroll-mt-6">
                  <h2 className={`${LABEL} mb-4 text-white light:text-[#0A0A0A]`}>
                    {g.title}
                  </h2>
                  <div className="flex flex-col gap-px">
                    {g.entries.map((entry) => (
                      <FaqItem key={entry.q} entry={entry} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      </main>
      <Closing />
    </div>
  );
}

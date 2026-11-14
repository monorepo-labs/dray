"use client";

import { useState } from "react";

import { PrIcon } from "@/components/app/Bot";
import { BrowserChrome } from "@/components/app/Browser";
import Panel from "@/components/app/Panel";
import Sidebar from "@/components/app/Sidebar";
import { BranchButton, ItemTab, PanelToggle } from "@/components/app/Tabs";
import Window from "@/components/app/Window";
import { MiniHome } from "@/components/home/MiniHome";
import { BOTS, BotMain, BotRows, BotTabs, BotTasks, useBotScene, type BotId } from "./BotScene";
import { ScaledWindow } from "./ScaledWindow";
import { TaskPanel } from "./TaskPanel";
import s from "./Hero.module.css";

const WIDTH = 1128;
const HEIGHT = 720;

/// The app, whole, above the fold, and the visitor can touch it. It opens on
/// the Dray bot's chat beside its Tasks tab, and the sidebar holds the bots
/// alone. A visitor can merge what a task left ready, open a task — which
/// brings its own PR, Changes and More panel — or the bot's page as a tab,
/// switch bots, and message one to watch it start a task. `startX` is where a
/// phone's sideways scroll opens; 0 opens on the sidebar.
export function Hero({ className, startX = 240 }: { className?: string; startX?: number }) {
  const [selected, setSelected] = useState<BotId>(BOTS[0].id);
  const scene = useBotScene(selected);
  const bot = BOTS.find((b) => b.id === selected) ?? BOTS[0];
  const view = scene.bots[bot.id].view;
  const task = scene.bots[bot.id].tasks.find((t) => t.id === view);

  const open = (id: BotId) => {
    setSelected(id);
    // On its chat, which is what reads the replies its badge counts.
    scene.show(id, "chat");
  };

  return (
    <ScaledWindow width={WIDTH} height={HEIGHT} minScale={0.7} startX={startX} className={`${s.scene} ${className ?? ""}`}>
      <Window
        interactive
        className="h-full w-full"
        sidebar={<Sidebar bots={<BotRows scene={scene} selected={selected} onOpen={open} />} />}
        tabs={<BotTabs scene={scene} bot={bot.id} name={bot.name} />}
        headerEnd={
          task ? (
            // A lit task is a session like any other: its branch, then its
            // pull request standing in for the panel toggle.
            <>
              <BranchButton name={task.branch} />
              {task.pr ? (
                <ItemTab icon={<PrIcon pr={task.pr} className="size-4" />} label={`#${task.pr.number}`} active fixed />
              ) : (
                <PanelToggle />
              )}
            </>
          ) : (
            <PanelToggle />
          )
        }
        main={<BotMain key={bot.id} scene={scene} bot={bot.id} browser={<DevServerPage />} />}
        panel={
          // A page wants the width, so the pane steps aside for it. A task
          // brings its own panel; the Tasks tab is the bot chat's alone.
          task ? (
            <TaskPanel
              key={task.id}
              task={task}
              merging={!!task.pr && scene.merging.has(task.pr.number)}
              onConfirm={() => task.pr && scene.confirm(bot.id, task.pr.number)}
            />
          ) : (
            view === "chat" && (
              <Panel tabs={[]} width={380}>
                <BotTasks scene={scene} bot={bot.id} />
              </Panel>
            )
          )
        }
      />
    </ScaledWindow>
  );
}

/// localhost:3000, the page the bot's browser has open, which is this site.
/// Its tab lives in the titlebar, so it draws a toolbar alone.
function DevServerPage() {
  return (
    <BrowserChrome url="localhost:3000" className="flex-1">
      <MiniHome />
    </BrowserChrome>
  );
}

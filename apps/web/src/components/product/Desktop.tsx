import { BatteryFull, Search, Wifi } from "lucide-react";

import { HardwareNotch, NOTCH_H, SYSTEM_FONT } from "./Island";

/// The menu bar, with the notch cut into it. Text menus only: no logo.
export function MenuBar({ clock = "Thu 22 Oct  9:41", compact = false }: { clock?: string; compact?: boolean }) {
  return (
    <div
      className="absolute inset-x-0 top-0 flex items-center bg-black/25 px-[18px] text-[13px] text-white backdrop-blur-xl"
      style={{ height: NOTCH_H, ...SYSTEM_FONT }}
    >
      {!compact && (
        <div className="flex gap-[18px]">
          <span className="font-bold">Finder</span>
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Go</span>
          <span>Window</span>
          <span>Help</span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-[15px]">
        <BatteryFull className="size-[19px]" strokeWidth={1.5} />
        <Wifi className="size-4" strokeWidth={2} />
        <Search className="size-[14px]" strokeWidth={2.25} />
        {!compact && <span className="whitespace-pre">{clock}</span>}
      </div>
      <HardwareNotch />
    </div>
  );
}

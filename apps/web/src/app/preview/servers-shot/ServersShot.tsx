"use client";

import dynamic from "next/dynamic";

const Scene = dynamic(() => import("@/components/illustrations/RemoteServersScene"), { ssr: false });

/// The scene at its drawn size, 1128×430, centred in a 1300×550 frame: the
/// capture runs at 2600×1100 with page zoom 200, so a centre crop of
/// 2256×860 is the scene exactly.
export function ServersShot({ bg }: { bg: string }) {
  return (
    <div className="fixed inset-0 z-[100]" style={{ background: bg }}>
      <div className="absolute" style={{ left: 86, top: 60, width: 1128, height: 430 }}>
        <Scene plain freeze />
      </div>
    </div>
  );
}

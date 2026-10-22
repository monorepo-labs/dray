"use client";

import dynamic from "next/dynamic";

/// three.js is most of a megabyte, so the scene loads on its own, in the
/// browser only, behind a box already holding its size.
const Scene = dynamic(() => import("./RemoteServersScene"), { ssr: false });

export function RemoteServers({ className }: { className?: string }) {
  return (
    <div className={`aspect-[1128/430] w-full ${className ?? ""}`}>
      <Scene />
    </div>
  );
}

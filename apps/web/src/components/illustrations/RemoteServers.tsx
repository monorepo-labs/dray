"use client";

import dynamic from "next/dynamic";
import { Component, type ReactNode } from "react";

/// three.js is most of a megabyte, so the scene loads on its own, in the
/// browser only, behind a box already holding its size.
const Scene = dynamic(() => import("./RemoteServersScene"), { ssr: false });

export function RemoteServers({ className, plain }: { className?: string; plain?: boolean }) {
  return (
    <div className={`aspect-[1128/430] w-full ${className ?? ""}`}>
      <Contained>
        <Scene plain={plain} />
      </Contained>
    </div>
  );
}

/// The scene is decoration: a browser that refuses a WebGL context, or a
/// renderer that fails to start, leaves its box empty rather than taking the
/// page down. R3F's `Canvas` rethrows those to its parent, which is here.
class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/// The plain scene as a still, shot at 2x off `/preview/servers-shot` and
/// matted to a transparent PNG. No three.js and no WebGL; `RemoteServers`
/// stays the live version.
export function RemoteServersStill({ className }: { className?: string }) {
  return <img src="/remote-servers.png" alt="" width={1128} height={430} className={`h-auto max-w-none ${className ?? "w-full"}`} />;
}

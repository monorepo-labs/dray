import type { ReactNode } from "react";

import { SiteNav } from "@/components/home/SiteNav";

import { Tiles } from "./SignInParts";

/// The whole page around one sign-in step: the site's own nav up top, the
/// step in the 960 column, the gate's tiles along the bottom. Its own file
/// because `SiteNav` is an async server component, and the client steps
/// import `SignInParts`.
export function SignInShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-home
      className="relative flex min-h-screen flex-col overflow-x-clip bg-black font-sans text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <Tiles />
      <div className="relative px-5 sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
        </div>
      </div>
      <main className="relative flex flex-1 items-center justify-center px-5 pt-16 pb-[200px] sm:px-8 sm:pb-[240px]">
        <div className="flex w-full max-w-[960px] flex-col">{children}</div>
      </main>
    </div>
  );
}

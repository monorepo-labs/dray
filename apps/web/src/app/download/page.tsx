import type { Metadata } from "next";

import { DownloadsShell } from "./shell";

export const metadata: Metadata = {
  title: "Download - Dray",
  description:
    "Download Dray for macOS or Linux (beta), or install it on a server. Free and open source.",
};

export default function Downloads() {
  return <DownloadsShell take="A" />;
}

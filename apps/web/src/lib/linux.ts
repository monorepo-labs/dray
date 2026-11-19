/// The Linux app's files, under the versionless names release.yml copies each
/// stable release to on R2 (`linux-release.sh`, #1276), the dmg's way. Linked
/// whether or not R2 holds them yet: until the first release built with #1276,
/// only the x64 AppImage is there and the other three 404.
export const LINUX_FORMATS = [
  {
    id: "deb",
    name: ".deb",
    target: "Debian and Ubuntu",
    files: { x64: "Dray_amd64.deb", arm64: "Dray_arm64.deb" },
  },
  {
    id: "appimage",
    name: "AppImage",
    target: "Any distro, no install",
    files: { x64: "Dray_amd64.AppImage", arm64: "Dray_arm64.AppImage" },
  },
] as const;

export type LinuxFormat = (typeof LINUX_FORMATS)[number]["id"];
export type LinuxArch = keyof (typeof LINUX_FORMATS)[number]["files"];

export function linuxUrl(file: string): string {
  return `https://downloads.drayhq.com/${file}`;
}

/// Where the Linux menu puts its Beta tag, stepped through on
/// `/review/linux-menu` while one is picked. Here rather than beside the menu,
/// since a server page cannot read a value out of a client module.
export const BETA_SPOTS = ["footer", "edge", "centre"] as const;
export type BetaSpot = (typeof BETA_SPOTS)[number];

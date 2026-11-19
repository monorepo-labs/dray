/// The Linux app's files, under the versionless names release.yml copies each
/// stable release to on R2 (`linux-release.sh`, #1276).
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

/// Which files R2 holds right now, so a button never leads to a 404: until
/// the first release built with #1276 lands, only the x64 AppImage is there.
/// A one-byte ranged GET rather than HEAD, since Next's data cache keeps only
/// GETs; cached ten minutes, so a new file lights up with no deploy. A failed
/// check counts as present, a link being worth more than a false "Soon".
/// An array, not a set, since it crosses into client components.
export async function availableLinuxFiles(): Promise<string[]> {
  const names: string[] = LINUX_FORMATS.flatMap((f) => Object.values(f.files));
  const found = await Promise.all(
    names.map(async (name) => {
      try {
        const res = await fetch(linuxUrl(name), {
          headers: { Range: "bytes=0-0" },
          next: { revalidate: 600 },
        });
        return res.status === 404 || res.status === 403 ? null : name;
      } catch {
        return name;
      }
    }),
  );
  return found.filter((n): n is string => n !== null);
}

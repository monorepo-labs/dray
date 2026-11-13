// A bot's face for the island, drawn by the app's own code: BotAvatar.tsx's
// props, as an SVG string JavaScriptCore can hand back. Bundled by bundle.sh.
import { blobatar } from "blobatar";
import { avatarProps, seededAvatar } from "../../desktop/src/lib/botAvatar";
import type { BotAvatar } from "../../desktop/src/types/events";

(globalThis as any).botFace = (seed: string, avatar: BotAvatar | null, size: number) =>
  blobatar(seed, { ...avatarProps(avatar ?? seededAvatar(seed)), size });

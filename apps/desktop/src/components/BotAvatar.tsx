import { Blobatar } from "@blobatar/react";
import { useGaze } from "@blobatar/react/gaze";
import { idle } from "blobatar/expression";
import "blobatar/motion.css";
import "blobatar/gaze.css";

import { avatarProps, seededAvatar } from "@/lib/botAvatar";
import { cn } from "@/lib/utils";
import type { BotAvatar as Avatar } from "@/types/events";

/// A bot's face. The avatar is what says a row is a bot — the sidebar names no
/// "Bots" section — so every surface draws it the same way.
export default function BotAvatar(props: FaceProps & {
  /// Eyes follow the cursor, for a row the reader is pointing at.
  follow?: boolean;
  /// Never follows, so no gaze runs at all. Gaze measures its face on every
  /// scroll anywhere on the page, even at rest, which a bot chat drawing a
  /// face on every task line paid hundreds of layouts per scroll for.
  still?: boolean;
}) {
  const { follow = false, still = false, ...face } = props;
  return still ? <Face {...face} /> : <GazingFace {...face} follow={follow} />;
}

type FaceProps = {
  /// The bot's id: what the face is seeded from where nothing was picked.
  seed: string;
  avatar: Avatar | null | undefined;
  className?: string;
  animate?: "hover" | "always";
};

function GazingFace({ follow, ...face }: FaceProps & { follow: boolean }) {
  // Travel is in the face's own 100-unit box; at 40px the library's suggested
  // 3 is about a pixel and reads as no movement.
  const { ref } = useGaze({ travel: 6, lookAt: follow ? "pointer" : "rest" });
  return <Face {...face} follow={follow} faceRef={ref} />;
}

function Face({
  seed,
  avatar,
  className,
  animate = "hover",
  follow = false,
  faceRef,
}: FaceProps & { follow?: boolean; faceRef?: React.Ref<SVGSVGElement> }) {
  return (
    <Blobatar
      ref={faceRef}
      name={seed}
      aria-hidden
      expression={idle}
      // A row being pointed at plays the face's motion, not only the face itself.
      animate={follow ? "always" : animate}
      // Never the library's own seeding, which can land on a shape SHAPES
      // leaves out: a face with no pick takes one seeded from SHAPES instead.
      {...avatarProps(avatar ?? seededAvatar(seed))}
      className={cn("shrink-0", className)}
    />
  );
}

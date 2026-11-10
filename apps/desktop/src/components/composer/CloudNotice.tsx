import Orb from "@/components/Orb";
import type { PlaceStep } from "@/lib/cloud";

const SAID: Record<PlaceStep, [string, string]> = {
  finding: ["Finding room on Dray Cloud", "Asking each machine how busy it is."],
  starting: ["Starting a cloud machine", "This can take a few minutes. The task goes when it's up."],
  cloning: ["Cloning onto a cloud machine", "The task goes once the clone lands."],
};

/// A new task being placed on Dray Cloud. Sits where `BoatNotice` does, in the
/// same shape, since it is the same wait seen from a task with no machine yet.
export default function CloudNotice({ step }: { step: PlaceStep }) {
  const [title, detail] = SAID[step];
  return (
    <div className="mb-2 flex min-h-7 items-center gap-2 px-1">
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Orb state="searching" variant="lighthouse" speed={3} label={title} />
      </span>
      <p className="min-w-0 flex-1 truncate text-ui text-foreground">
        {title}
        <span className="text-muted-foreground">
          {" · "}
          {detail}
        </span>
      </p>
    </div>
  );
}

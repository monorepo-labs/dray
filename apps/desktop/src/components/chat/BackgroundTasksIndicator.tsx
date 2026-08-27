import Orb from "@/components/Orb";

/// Standing notice that async subagents are still working — driven by the
/// latest `background_tasks_changed` set, so it outlives the turn that spawned
/// the tasks and leaves when the set drains.
///
/// A button, because this is the one row on screen that says work is happening
/// somewhere the transcript does not show it — the panel is where that work
/// lives, and asking the reader to find the tab themselves is asking them to
/// know the panel has one. Opens the subagents tab rather than toggling: a
/// notice that closed the thing it points at would be a lie the second time it
/// is pressed.
///
/// No chevron and no hover chrome. `SubagentRow` earns one by sitting in a
/// column of rows that mostly do not open anything; this sits alone below the
/// transcript, where the affordance is the row itself.
export default function BackgroundTasksIndicator({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Show ${count} background task${count === 1 ? "" : "s"} in the subagent panel`}
      className="flex cursor-pointer items-center gap-2 text-left"
    >
      {/* Same 20px inline design as WorkingIndicator, `weaving` so the two
          read as different activities at a glance. Theme pinned for the same
          reason as there: the orb's `auto` expects `data-theme="dark|light"`
          and this app stamps a palette name instead. */}
      <Orb state="weaving" size={20} aria-hidden />

      <span className="shimmer-text text-chat">
        {count} Background Task{count === 1 ? "" : "s"}
      </span>
    </button>
  );
}

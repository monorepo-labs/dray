import { Plus } from "lucide-react";

import BranchSelector from "@/components/composer/BranchSelector";
import BranchSwitchDialog from "@/components/composer/BranchSwitchDialog";
import ContextMeter from "@/components/composer/ContextMeter";
import ModelSelector from "@/components/composer/ModelSelector";
import PermissionSelector from "@/components/composer/PermissionSelector";
import ProjectSelector from "@/components/composer/ProjectSelector";
import WorktreeToggle from "@/components/composer/WorktreeToggle";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  ApprovalPolicy,
  BranchList,
  Effort,
  Model,
  ModelId,
  Project,
} from "@/types/events";

export type ComposerToolbarProps = {
  models: Model[];
  modelId: ModelId;
  effort: Effort | null;
  onModelChange: (modelId: ModelId, effort: Effort | null) => void;

  permissionMode: ApprovalPolicy;
  onPermissionModeChange: (mode: ApprovalPolicy) => void;

  projects: Project[];
  projectPath: string | null;
  onSelectProject: (path: string) => void;
  onAttachProject: () => void;

  branches: BranchList | null;
  branch: string | null;
  onSelectBranch: (branch: string) => void;

  /// Set while a switch waits on the uncommitted-changes prompt.
  pendingBranch: string | null;
  onConfirmBranchSwitch: (stash: boolean) => void;
  onCancelBranchSwitch: () => void;

  useWorktree: boolean;
  onToggleWorktree: () => void;

  /// Opens the file picker. The attachments themselves are held in a
  /// module-level store keyed by session, not passed through here — this row is
  /// handed to `ChatInput` as an opaque node, so the two cannot share props.
  onAttach: () => void;

  /// How full the model's context is, or `null` before any turn has reported
  /// it. Sits at the far end of the row rather than among the pickers: it
  /// reports rather than sets, and nothing here changes it.
  contextUsage: { used: number; max: number } | null;

  /// Where the session runs is fixed at creation, so the last three controls
  /// only exist before one starts.
  isNewSession: boolean;
};

/// The composer's control row. Model and permission change a running session in
/// place; project, branch, and worktree decide where it starts and disappear
/// once it has — a control that can never be used is noise, and the session
/// header already shows the project and branch. Its own spacing from the card is
/// the caller's, since only the caller knows which side of it the row sits on.
export default function ComposerToolbar({
  models,
  modelId,
  effort,
  onModelChange,
  permissionMode,
  onPermissionModeChange,
  projects,
  projectPath,
  onSelectProject,
  onAttachProject,
  branches,
  branch,
  onSelectBranch,
  pendingBranch,
  onConfirmBranchSwitch,
  onCancelBranchSwitch,
  useWorktree,
  onToggleWorktree,
  onAttach,
  contextUsage,
  isNewSession,
}: ComposerToolbarProps) {
  return (
    <div className="flex min-w-0 items-center gap-0.5 px-1">
      {/* No radius override: `icon-sm` already carries the app's rounded-square,
          and a circle here would be the one round control in a row of them. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onAttach}
            aria-label="Attach files"
            className="text-muted-foreground"
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          Attach files
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>⌥</Kbd>
            <Kbd>O</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>

      <ModelSelector
        models={models}
        modelId={modelId}
        effort={effort}
        onChange={onModelChange}
      />

      {isNewSession && (
        <>
          <ProjectSelector
            projects={projects}
            value={projectPath}
            onSelect={onSelectProject}
            onAttach={onAttachProject}
          />

          {/* Both describe a repo, so neither means anything until one is
              picked — and a worktree has nothing to fork from. */}
          {projectPath && (
            <>
              <WorktreeToggle on={useWorktree} onToggle={onToggleWorktree} />

              {/* A worktree forks from the remote's default branch no matter
                  what is checked out, so offering a branch here would promise
                  something the CLI doesn't honour. State the real base instead. */}
              {useWorktree ? (
                branches?.defaultBase && (
                  <span className="truncate px-1.5 text-ui text-muted-foreground/60">
                    from {branches.defaultBase}
                  </span>
                )
              ) : (
                // Relative, so the switch popover anchors to the picker rather
                // than to the window.
                <div className="relative flex min-w-0 items-center">
                  <BranchSelector
                    branches={branches}
                    value={branch}
                    onSelect={onSelectBranch}
                    disabled={pendingBranch !== null}
                  />
                  <BranchSwitchDialog
                    target={pendingBranch}
                    dirty={branches?.dirty ?? 0}
                    onConfirm={onConfirmBranchSwitch}
                    onCancel={onCancelBranchSwitch}
                  />
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Last of the pickers: it is the one control here most sessions set once
          and never touch, so it sits furthest from where the eye lands. */}
      <PermissionSelector value={permissionMode} onChange={onPermissionModeChange} />

      {/* `ml-auto` rather than a spacer, so a long branch name still gets the
          whole middle of the row and this stays pinned to the right edge. */}
      {contextUsage && (
        <div className="ml-auto">
          <ContextMeter used={contextUsage.used} max={contextUsage.max} />
        </div>
      )}
    </div>
  );
}

import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CrewReportId, CrewTaskId } from "@t3tools/contracts";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { crewEnvironment } from "~/state/crew";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import * as Schema from "effect/Schema";

import { CrewPanel } from "../CrewPanel";

const CREW_SECTION_EXPANDED_KEY = "sidebar:crew-expanded";

/**
 * Mounts the crew panel and owns its three operator actions.
 *
 * Lives in the shared sidebar chrome, which both `Sidebar.tsx` and
 * `LegacySidebar.tsx` render, so the panel exists in both without a second
 * copy. `legacySidebarEnabled` defaults to false, so the modern sidebar is what
 * most operators see — but a feature that only appears in one of them is the
 * most common defect shape in this repo.
 *
 * Collapsed by default, and the panel keeps polling while collapsed so the
 * header count is live. Putting the poll inside the expanded body would leave
 * the collapsed header showing nothing.
 */
export function SidebarCrew() {
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();

  const [expanded, setExpanded] = useLocalStorage(CREW_SECTION_EXPANDED_KEY, false, Schema.Boolean);
  const onToggle = useCallback(() => setExpanded((value) => !value), [setExpanded]);

  const teardownCommand = useAtomCommand(crewEnvironment.teardown, { label: "crew:teardown" });
  const answerCommand = useAtomCommand(crewEnvironment.answer, { label: "crew:answer" });
  const forgetCommand = useAtomCommand(crewEnvironment.forgetWorktree, {
    label: "crew:forget-worktree",
  });

  const onTeardown = useCallback(
    (taskId: string) => {
      if (environmentId == null) return;
      void teardownCommand({ environmentId, input: { taskId: CrewTaskId.make(taskId) } });
    },
    [environmentId, teardownCommand],
  );

  const onAnswer = useCallback(
    (reportId: string, text: string) => {
      if (environmentId == null) return;
      void answerCommand({
        environmentId,
        input: { reportId: CrewReportId.make(reportId), text },
      });
    },
    [answerCommand, environmentId],
  );

  const onForgetWorktree = useCallback(
    (taskId: string) => {
      if (environmentId == null) return;
      void forgetCommand({ environmentId, input: { taskId: CrewTaskId.make(taskId) } });
    },
    [environmentId, forgetCommand],
  );

  const onOpenThread = useCallback(
    (threadId: string) => {
      if (environmentId == null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    },
    [environmentId, navigate],
  );

  if (environmentId == null) return null;

  return (
    <CrewPanel
      expanded={expanded}
      onToggle={onToggle}
      onOpenThread={onOpenThread}
      onTeardown={onTeardown}
      onAnswer={onAnswer}
      onForgetWorktree={onForgetWorktree}
    />
  );
}

// FORK-ONLY. Fork web files the React Compiler does not accept yet; they predate upstream's
// every-file-compiles rule (lint plus src/reactCompilerCoverage.test.ts) and keep manual memo.
// Both lists only shrink: the coverage test fails when a listed bailout starts compiling.

/** Files the compiler skips today (checked by reactCompilerCoverage.test.ts). */
export const FORK_REACT_COMPILER_BAILOUTS: ReadonlyArray<string> = [
  "apps/web/src/components/QueueSlotsControl.tsx",
  "apps/web/src/components/SidebarQueueBlock.tsx",
  "apps/web/src/components/TaskListPanel.tsx",
  "apps/web/src/components/ThreadQueueServerSync.tsx",
  "apps/web/src/components/WorkspaceMemberEditor.tsx",
  "apps/web/src/components/chat/streamingMarkdownText.ts",
  "apps/web/src/components/settings/NotificationsSettings.tsx",
  "apps/web/src/hooks/useLlmModels.ts",
  "apps/web/src/hooks/useResourceQueue.ts",
  "apps/web/src/hooks/useSubagentBackend.ts",
  "apps/web/src/hooks/useThreadCompletionNotifications.ts",
];

/** Files exempt from the web React Compiler lint rules and t3code/no-manual-memo. */
export const FORK_REACT_COMPILER_LINT_EXEMPT: ReadonlyArray<string> = [
  "apps/web/src/components/OutboxFlushCoordinator.tsx",
  "apps/web/src/components/QueueSlotsControl.tsx",
  "apps/web/src/components/SidebarQueueBlock.tsx",
  "apps/web/src/components/TaskListPanel.tsx",
  "apps/web/src/components/ThreadQueueCoordinator.tsx",
  "apps/web/src/components/ThreadQueueServerSync.tsx",
  "apps/web/src/components/WorkspaceMemberEditor.tsx",
  "apps/web/src/components/WorkspaceRepoBar.tsx",
  "apps/web/src/components/chat/ComposerShortcutsControls.tsx",
  "apps/web/src/components/chat/VitalsGauge.tsx",
  "apps/web/src/components/chat/streamingMarkdownText.ts",
  "apps/web/src/components/chat/useChatEscapeKey.dom.test.tsx",
  "apps/web/src/components/settings/NotificationsSettings.tsx",
  "apps/web/src/components/settings/localLlm/LocalLlmSettings.tsx",
  "apps/web/src/components/settings/providers/PresetDialog.tsx",
  "apps/web/src/components/sidebar/SidebarLocalModels.tsx",
  "apps/web/src/components/sidebar/SidebarResourceQueue.tsx",
  "apps/web/src/components/sidebar/SidebarSubagentBackend.tsx",
  "apps/web/src/hooks/useHostMetrics.ts",
  "apps/web/src/hooks/useLlmModels.ts",
  "apps/web/src/hooks/useResourceQueue.ts",
  "apps/web/src/hooks/useSubagentBackend.ts",
  "apps/web/src/hooks/useThreadCompletionNotifications.ts",
  "apps/web/src/hooks/useWorkspaceRepos.ts",
  "apps/web/src/queueSlotSettings.ts",
  "apps/web/src/routes/viewer.$.tsx",
  "apps/web/src/sidebarCustomSections.ts",
];

import type { EnvironmentId, T3ProjectFileScript, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { PopoverCreateHandle } from "../ui/popover";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  density: "full" as "full" | "compact" | "essential",
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({
    children,
  }: {
    children: (density: typeof testState.density) => React.ReactNode;
  }) => children(testState.density),
}));

import type { DraftId } from "../../composerDraftStore";
import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

function panelProps(overrides: Partial<ThreadDetailsPanelProps> = {}): ThreadDetailsPanelProps {
  return {
    anchor: { current: null },
    handle: PopoverCreateHandle(),
    onPresentationChange: vi.fn(),
    environmentId: "environment:thread-details" as EnvironmentId,
    threadId: "thread:thread-details" as ThreadId,
    activeProjectName: undefined,
    activeProjectScripts: [],
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    showOpenInPicker: false,
    gitCwd: "/tmp/thread-details-project",
    isGitRepo: false,
    envLocked: false,
    availableEnvironments: [],
    onEnvironmentChange: vi.fn(),
    onEnvModeChange: vi.fn(),
    envMode: "local",
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    onComposerFocusRequest: vi.fn(),
    versionMismatch: null,
    onDismissVersionMismatch: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
    onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
    onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    taskListView: { primary: null, primaryKind: null, history: [] },
    taskListActive: false,
    backgroundTasks: [],
    ...overrides,
  };
}

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
    testState.density = "full";
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props = panelProps({ environmentId, gitCwd });

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  it("shows the thread's task list, but not on a draft", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const taskListView: ThreadDetailsPanelProps["taskListView"] = {
      primary: {
        createdAt: "2026-10-08T10:00:00.000Z",
        runId: null,
        groupKey: "run-1",
        steps: [
          { step: "Read the code", status: "completed" },
          { step: "Write the fix", status: "inProgress" },
        ],
      },
      primaryKind: "latest",
      history: [],
    };

    expect(
      renderToStaticMarkup(<ThreadDetailsPanel {...panelProps({ taskListView })} />),
    ).toContain("Tasks · 1/2");
    expect(
      renderToStaticMarkup(
        <ThreadDetailsPanel {...panelProps({ taskListView, draftId: "draft-1" as DraftId })} />,
      ),
    ).not.toContain("Tasks ·");
  });

  it("shows the task list at the essential density too", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    testState.density = "essential";
    const taskListView: ThreadDetailsPanelProps["taskListView"] = {
      primary: {
        createdAt: "2026-10-08T10:00:00.000Z",
        runId: null,
        groupKey: "run-1",
        steps: [{ step: "Read the code", status: "completed" }],
      },
      primaryKind: "latest",
      history: [],
    };
    expect(
      renderToStaticMarkup(<ThreadDetailsPanel {...panelProps({ taskListView })} />),
    ).toContain("Tasks · 1/1");
  });
});

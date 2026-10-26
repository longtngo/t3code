import { cloneElement, type ReactElement, type ReactNode } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";

import "~/index.css";

const state = vi.hoisted(() => ({
  stopWorkflowLabel: "environment-data:orchestration:stop-workflow",
  projection: null as unknown,
  navigate: vi.fn(),
  shells: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  showTooltips: false,
  command: vi.fn().mockResolvedValue({ _tag: "Success" }),
  workflowCommand: vi.fn().mockResolvedValue({ _tag: "Success" }),
  toast: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: (() => ({ projection: state.projection })) as never,
  useThreadRelationshipShells: ((ref: { readonly environmentId: string }) =>
    (state.shells as ReadonlyArray<{ readonly environmentId: string; readonly source: unknown }>)
      .filter((shell) => shell.environmentId === ref.environmentId)
      .map((shell) => shell.source)) as never,
  useProjects: (() => state.projects) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() =>
    new Map(
      [...state.configs].map(([id, config]) => [id, (config as { providers: unknown }).providers]),
    )) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), async (original) => ({
  ...(await original()),
  useArchivedThreadSnapshots: (() => ({ snapshots: [] })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    command.label === state.stopWorkflowLabel ? state.workflowCommand : state.command) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } as never };
});
vi.mock(import("../../state/orchestration"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const granted = Atom.make(true);
  const stopWorkflow = actual.orchestrationEnvironment.stopWorkflow;
  return {
    ...actual,
    orchestrationEnvironment: Object.assign(Object.create(actual.orchestrationEnvironment), {
      stopWorkflow: Object.assign(Object.create(stopWorkflow), {
        label: state.stopWorkflowLabel,
        permissionAtom: () => granted,
      }),
    }),
  };
});
// Tooltip and hover card content renders inline so the suite can read every row's agent
// details across many states without hovering each row.
vi.mock(import("../ui/tooltip"), async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: (({ children }: { children: ReactNode }) => children) as never,
    TooltipTrigger: (({ render, children }: { render: ReactElement; children: ReactNode }) =>
      cloneElement(render, {}, children)) as never,
    TooltipPopup: (({ children }: { children: ReactNode }) =>
      state.showTooltips ? children : null) as never,
  };
});

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

let screen: Screen;
let current: ReactElement;

async function renderPanel(element: ReactElement) {
  current = element;
  screen = await render(element);
  return screen;
}
// The mocked hooks read `state` while rendering, so a new element picks up changes.
const update = () => screen.rerender(cloneElement(current));
const click = (element: HTMLElement) => act(async () => element.click());
const buttons = () => [...screen.container.querySelectorAll("button")];
// FORK: row-group disclosures only. The section's own fold toggle sits in its heading
// (collapseKey="lineage") and is excluded, or the first expanded toggle would fold Lineage.
const sectionToggles = (expanded: boolean) =>
  buttons().filter(
    (button) =>
      button.getAttribute("aria-expanded") === String(expanded) &&
      !button.hasAttribute("aria-label") &&
      button.closest("h3") === null,
  );
function sectionToggle(expanded: boolean) {
  const [toggle] = sectionToggles(expanded);
  if (!toggle) throw new Error(`No ${expanded ? "expanded" : "collapsed"} section toggle`);
  return toggle;
}
const heading = () => screen.container.querySelector("h3")?.textContent;
// Joins rendered text nodes; `visibleOnly` drops screen-reader-only text.
function textNodes(separator: string, visibleOnly = false) {
  const walker = document.createTreeWalker(screen.container, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (visibleOnly && node.parentElement?.closest(".sr-only")) continue;
    parts.push(node.textContent ?? "");
  }
  return parts.join(separator);
}

it("shows the matching child agent details and refreshes them when the agent settles", async () => {
  const agent = {
    id: "agent-1",
    driver: "codex",
    providerInstanceId: "codex",
    childThreadId: "child-1",
    title: "Checker",
    prompt: "Check the change",
    model: "gpt-5.4",
    status: "running",
    progress: "Running checks",
    result: null,
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
  };
  const projection = {
    thread: {
      id: "parent",
      lineage: { relationshipToParent: null },
      activeProviderThreadId: null,
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      { ...agent, id: "unlinked", childThreadId: null, title: "Unlinked agent" },
      agent,
      { ...agent, id: "agent-2", childThreadId: "child-2", title: "Worker", model: "gpt-5.3" },
    ],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await using _screen = await renderPanel(panel);
  const text = () => textNodes(" ").replace(/\s+/g, " ");
  expect(text()).toContain("Checker");
  expect(text()).toContain("Lineage · 3 running");
  expect(text()).toContain("running");
  expect(text()).not.toContain("gpt-5.4");
  expect(text()).not.toContain("gpt-5.3");
  expect(text()).not.toContain("tok");
  expect(text()).not.toContain("Unlinked agent");
  expect(text()).not.toContain("Active agents");
  expect(sectionToggles(true)).toHaveLength(0);

  state.projection = {
    ...projection,
    subagents: [
      {
        ...agent,
        status: "completed",
        progress: undefined,
        result: "All checks passed",
        completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
      },
    ],
  };
  await update();
  expect(heading()).toBe("Lineage");
  expect(text()).toContain("Previous agents 1");
  expect(text()).not.toContain("Checker");
  await click(sectionToggle(false));
  expect(text()).toContain("Checker");
  expect(text()).toContain("Checker 2m");
  expect(text()).not.toContain("Previous agents 1");
  expect(text()).not.toContain("Done");
  expect(text()).not.toContain("running");
  expect(text()).not.toContain("Worker");
  await click(sectionToggle(true));
  expect(text()).not.toContain("Checker");
  expect(text()).toContain("Previous agents 1");
  await click(sectionToggle(false));
  expect(text()).toContain("Checker");

  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `running-agent-${index}`,
      childThreadId: `running-child-${index}`,
    })),
  };
  await update();
  expect(text()).toContain("Lineage · 8 running");

  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `old-agent-${index}`,
      childThreadId: `old-child-${index}`,
      status: index === 7 ? "failed" : "completed",
      title: `Old agent ${index}`,
      result: index === 7 ? "Earlier build failed" : "Done",
      completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
    })),
  };
  await update();
  expect(text()).toContain("1 failed");
  expect(text()).not.toContain("Old agent 7");
  // FORK: Lineage pages by the rows-per-section setting and scrolls with the details card, so
  // its row lists never scroll on their own and Show more sits after the rows.
  const lists = [
    ...screen.container.querySelectorAll<HTMLElement>('ul[aria-label="Related threads"]'),
  ];
  expect(lists.length).toBeGreaterThan(0);
  for (const list of lists) {
    expect(list.className).not.toContain("max-h-");
    expect(list.className).not.toContain("overflow-y-auto");
  }
  const showMore = buttons().find((button) => button.textContent?.startsWith("Show "))!;
  expect(showMore.previousElementSibling?.getAttribute("aria-label")).toBe("Related threads");
  await click(showMore);
  expect(text()).toContain("Old agent 7");

  state.projection = {
    ...projection,
    subagents: [{ ...agent, childThreadId: null }],
  };
  await update();
  expect(text()).toContain("Lineage · 1 running");
});

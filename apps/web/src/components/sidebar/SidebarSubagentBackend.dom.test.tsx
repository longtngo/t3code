import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type SubagentBackendState,
} from "@t3tools/contracts";

/**
 * The footer's Subagents control on a Default machine backend: threads set to Cursor turn the
 * icon's name into a count and keep the Cursor model picker reachable. The counting itself is
 * the real `offloadedThreadCount` over these settings and threads; only the data sources
 * (primary settings, thread index, the backend `get`) are stubbed.
 */

const fixture = vi.hoisted(() => ({
  modes: {} as Record<string, "inherit" | "on" | "off">,
  countAtom: null as unknown,
}));

const threadOnCursor = "thread-on-cursor";
const backendState: SubagentBackendState = {
  backend: "default",
  instanceId: null,
  model: null,
  instances: [{ instanceId: "cursor" as never, displayName: "Cursor" }],
  models: [{ id: "auto", label: "Auto" }],
  degraded: null,
};

function primarySettings() {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    subagentBackendEnabled: true,
    subagentBackendThreadModes: fixture.modes,
    providerInstances: {
      cursor: { driver: "cursor", enabled: true, config: {} },
    },
  } as unknown as typeof DEFAULT_UNIFIED_SETTINGS;
}

vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "env-1",
        serverConfig: { environment: { capabilities: { subagentBackend: true } } },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "env-1",
}));
vi.mock("../../hooks/useSubagentBackend", () => ({
  useSubagentBackend: () => ({ state: backendState, usage: null, pending: false, set: () => {} }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
  usePrimarySettings: (select?: (settings: unknown) => unknown) =>
    select ? select(primarySettings()) : primarySettings(),
  useEnvironmentSettings: () => primarySettings(),
  useUpdateEnvironmentSettings: () => () => {},
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryServerProvidersAtom: Atom.make([]) };
});
vi.mock("../../state/subagentOffload", () => ({
  offloadedThreadCountAtom: () => fixture.countAtom,
}));

import { Atom } from "effect/reactivity";
import type { ThreadId } from "@t3tools/contracts";
import { offloadedThreadCount } from "./sidebarSubagentBackend.logic";
import { SidebarSubagentBackend } from "./SidebarSubagentBackend";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { renderDom } from "../../testing/renderDom";

function renderFooter() {
  return renderDom(
    createElement(
      SidebarProvider,
      null,
      createElement(SidebarMenu, null, createElement(SidebarSubagentBackend)),
    ),
  );
}

type View = Awaited<ReturnType<typeof renderFooter>>;

const trigger = (view: View) => view.find("button[aria-expanded]");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.modes = {};
  // A fresh atom per test, read lazily at render, so each test's modes are the ones counted.
  // One live thread exists; whether it counts depends on the modes the test sets.
  fixture.countAtom = Atom.make(() =>
    offloadedThreadCount(
      primarySettings(),
      new Map([[threadOnCursor as ThreadId, { archivedAt: null }]]),
    ),
  );
});

describe("Subagents footer control on a Default backend", () => {
  it("names the count of threads set to Cursor and offers the Cursor model picker", async () => {
    fixture.modes = { [threadOnCursor]: "on" };
    const view = await renderFooter();

    expect(trigger(view)?.getAttribute("aria-label")).toBe("Subagents · 1 thread set to Cursor");
    // The icon itself: yellow, with the count beside it.
    expect(trigger(view)?.textContent).toBe("1");
    expect(trigger(view)?.querySelector("svg")?.classList.contains("text-warning")).toBe(true);

    await view.click(trigger(view));
    expect(view.find('[aria-label="Cursor model"]')).not.toBeNull();
    expect(view.text()).toContain("Model for this machine's threads set to Cursor:");
  });

  it("reads Default and hides the picker when no thread is set to Cursor", async () => {
    const view = await renderFooter();

    expect(trigger(view)?.getAttribute("aria-label")).toBe("Subagents · Default");
    expect(trigger(view)?.textContent).toBe("");
    expect(trigger(view)?.querySelector("svg")?.classList.contains("text-warning")).toBe(false);

    await view.click(trigger(view));
    expect(view.find('[aria-label="Subagent backend"]')).not.toBeNull();
    expect(view.find('[aria-label="Cursor model"]')).toBeNull();
    expect(view.text()).not.toContain("set to Cursor:");
  });
});

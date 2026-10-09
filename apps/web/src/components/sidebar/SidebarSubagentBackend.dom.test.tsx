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
  canSet: true,
  setDenied: false,
  refusal: null as string | null,
  allowSpendingCredits: true,
  providers: [] as unknown[],
  providersAtom: null as unknown,
  canWriteSettings: true,
  routeParams: {} as Record<string, string>,
  sent: [] as unknown[],
}));

const threadOnCursor = "thread-on-cursor";
const backendState: SubagentBackendState = {
  backend: "default",
  instanceId: null,
  model: null,
  instances: [
    { instanceId: "cursor" as never, displayName: "Cursor" },
    { instanceId: "cursor_work" as never, displayName: "Cursor Work" },
  ],
  models: [
    { id: "auto", label: "Auto" },
    { id: "sonnet", label: "Sonnet" },
  ],
  degraded: null,
};

function primarySettings() {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    subagentBackendEnabled: true,
    allowSpendingCredits: fixture.allowSpendingCredits,
    subagentBackendThreadModes: fixture.modes,
    providerInstances: {
      cursor: { driver: "cursor", enabled: true, config: {} },
    },
  } as unknown as typeof DEFAULT_UNIFIED_SETTINGS;
}

vi.mock("@tanstack/react-router", () => ({
  useParams: (options: { select: (params: Record<string, string>) => unknown }) =>
    options.select(fixture.routeParams),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "env-1",
        serverConfig: {
          environment: {
            capabilities: { subagentBackend: true, subagentBackendThreadModes: true },
          },
        },
      },
      {
        environmentId: "env-2",
        serverConfig: {
          environment: { capabilities: { subagentBackendThreadModes: true } },
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "env-1",
}));
vi.mock("../../hooks/useSubagentBackend", () => ({
  useSubagentBackend: () => ({
    state: backendState,
    usage: null,
    pending: false,
    canSet: fixture.canSet,
    refusal: fixture.refusal,
    set: (input: unknown) => fixture.sent.push(input),
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
  usePrimarySettings: (select?: (settings: unknown) => unknown) =>
    select ? select(primarySettings()) : primarySettings(),
  useEnvironmentSettings: () => primarySettings(),
  useUpdateEnvironmentSettings: () => () => {},
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => fixture.canWriteSettings,
  useEnvironmentScopeDenied: () => fixture.setDenied,
}));
vi.mock("../../state/server", () => ({
  // A getter, so each test's fresh atom is the one the component reads.
  get primaryServerProvidersAtom() {
    return fixture.providersAtom;
  },
}));
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
  fixture.canSet = true;
  fixture.setDenied = false;
  fixture.refusal = null;
  fixture.allowSpendingCredits = true;
  fixture.providers = [];
  fixture.providersAtom = Atom.make(() => fixture.providers);
  fixture.canWriteSettings = true;
  fixture.routeParams = {};
  fixture.sent = [];
  // A fresh atom per test, read lazily at render, so each test's modes are the ones counted.
  // One live thread exists; whether it counts depends on the modes the test sets.
  fixture.countAtom = Atom.make(() =>
    offloadedThreadCount(
      { settings: primarySettings(), providers: fixture.providers as never },
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

describe("Subagents footer control without permission to change the backend", () => {
  const segment = (view: View, label: string) =>
    view
      .findAll<HTMLButtonElement>('[aria-label="Subagent backend"] button')
      .find((button) => button.textContent === label) ?? null;

  it("sends the switch when the connection may change the backend", async () => {
    const view = await renderFooter();
    await view.click(trigger(view));
    await view.click(segment(view, "Cursor"));

    expect(fixture.sent).toEqual([{ backend: "cursor", instanceId: "cursor" }]);
    expect(view.text()).not.toContain("does not have permission");
  });

  it("disables the machine controls, sends nothing, and says why", async () => {
    fixture.canSet = false;
    fixture.setDenied = true;
    fixture.modes = { [threadOnCursor]: "on" };
    const view = await renderFooter();
    await view.click(trigger(view));
    await view.click(segment(view, "Cursor"));

    expect(fixture.sent).toEqual([]);
    expect(segment(view, "Cursor")?.disabled).toBe(true);
    expect(segment(view, "Default")?.disabled).toBe(true);
    expect(view.find<HTMLButtonElement>('[aria-label="Cursor model"]')?.disabled).toBe(true);
    expect(view.text()).toContain(
      "This connection does not have permission to change the subagent backend.",
    );
  });

  // `canSet` is also false while the grant loads, or offline before it is confirmed; that is
  // not a denial, so the controls wait without claiming one.
  it("disables without a permission line while the grant is not yet known", async () => {
    fixture.canSet = false;
    const view = await renderFooter();
    await view.click(trigger(view));

    expect(segment(view, "Cursor")?.disabled).toBe(true);
    expect(view.text()).not.toContain("does not have permission");
  });

  it("keeps the thread's own permission line when its thread is on another environment", async () => {
    fixture.canSet = false;
    fixture.setDenied = true;
    fixture.canWriteSettings = false;
    fixture.routeParams = { environmentId: "env-2", threadId: threadOnCursor };
    const view = await renderFooter();
    await view.click(trigger(view));

    expect(view.text().match(/does not have permission/g)).toHaveLength(2);
  });

  it("shows one permission line when neither the backend nor settings can change", async () => {
    fixture.canSet = false;
    fixture.setDenied = true;
    fixture.canWriteSettings = false;
    fixture.routeParams = { environmentId: "env-1", threadId: threadOnCursor };
    const view = await renderFooter();
    await view.click(trigger(view));

    // The thread's segment is mounted and read-only too.
    expect(view.find('[aria-label="This thread\'s subagent backend"]')).not.toBeNull();
    expect(view.text().match(/does not have permission/g)).toHaveLength(1);
  });

  it("keeps the settings line when only settings cannot change", async () => {
    fixture.canWriteSettings = false;
    fixture.routeParams = { environmentId: "env-1", threadId: threadOnCursor };
    const view = await renderFooter();
    await view.click(trigger(view));

    expect(view.text()).toContain(
      "This connection does not have permission to change environment settings.",
    );
  });
});

describe("Subagents panel after a refused pick", () => {
  it("shows the refusal in the panel while the row keeps the stored backend", async () => {
    fixture.refusal = 'Instance "old" is not an enabled Cursor instance.';
    const view = await renderFooter();

    expect(trigger(view)?.getAttribute("aria-label")).toBe("Subagents · Default");
    await view.click(trigger(view));
    expect(view.text()).toContain('Instance "old" is not an enabled Cursor instance.');
  });
});

describe("Subagents panel for a thread set to Cursor that cannot offload", () => {
  it("says why and keeps the model picker while Cursor credits are used up", async () => {
    fixture.modes = { [threadOnCursor]: "on" };
    fixture.allowSpendingCredits = false;
    fixture.providers = [
      {
        instanceId: "cursor",
        driver: "cursor",
        enabled: true,
        models: [{ slug: "auto-smart", name: "Auto" }],
        usageLimits: {
          checkedAt: "2026-10-09T00:00:00.000Z",
          windows: [
            { id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 },
          ],
        },
      },
    ];
    fixture.routeParams = { environmentId: "env-1", threadId: threadOnCursor };
    const view = await renderFooter();

    expect(trigger(view)?.getAttribute("aria-label")).toBe("Subagents · Default");
    await view.click(trigger(view));
    expect(view.text()).toContain(
      'Cursor has used 100% of its usage and "Allow to spend credits" is off.',
    );
    // Picked now, used once credits reset.
    expect(view.find('[aria-label="Cursor model"]')).not.toBeNull();
  });
});

describe("Subagents panel pickers", () => {
  const pick = async (view: View, label: string, option: string) => {
    await view.click(view.find(`[role="combobox"][aria-label="${label}"]`));
    // The Base UI popup portals outside the mount host, so it is queried from the document.
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    await view.click(options.find((entry) => entry.textContent === option) ?? null);
  };

  // A picker only retargets; `targetOnly` keeps a stale panel from switching the backend.
  it("sends a model pick as target-only", async () => {
    fixture.modes = { [threadOnCursor]: "on" };
    const view = await renderFooter();
    await view.click(trigger(view));
    await pick(view, "Cursor model", "Sonnet");

    expect(fixture.sent).toEqual([
      { backend: "default", instanceId: "cursor", model: "sonnet", targetOnly: true },
    ]);
  });

  it("sends an instance pick as target-only", async () => {
    fixture.modes = { [threadOnCursor]: "on" };
    const view = await renderFooter();
    await view.click(trigger(view));
    await pick(view, "Cursor instance", "Cursor Work");

    expect(fixture.sent).toEqual([
      { backend: "default", instanceId: "cursor_work", targetOnly: true },
    ]);
  });
});

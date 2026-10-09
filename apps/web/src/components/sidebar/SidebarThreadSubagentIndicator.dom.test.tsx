import { RegistryContext } from "@effect/atom-react";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ServerConfig } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";

/**
 * The sidebar row's Cursor indicator, from the environment's server config to the icon. Only the
 * config source is stubbed; the per-thread atom and `threadOffloadedToCursor` are the real ones.
 */

const fixture = vi.hoisted(() => ({ configs: new Map<string, unknown>() }));

vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: (id: string) => fixture.configs.get(id) },
}));
vi.mock("../../state/threads", () => ({ environmentThreadShells: {} }));

import { SidebarThreadSubagentIndicator } from "./SidebarThreadSubagentIndicator";
import { renderDom } from "../../testing/renderDom";

const env = EnvironmentId.make("env-indicator");
const otherEnv = EnvironmentId.make("env-indicator-other");
const thread = ThreadId.make("thread-indicator");

function config(modes: Record<string, string>, providers: unknown[] = []) {
  return {
    settings: {
      subagentBackendEnabled: true,
      allowSpendingCredits: false,
      subagentBackendThreadModes: modes,
      providerInstances: { cursor: { driver: "cursor", enabled: true, config: {} } },
    },
    providers,
  } as unknown as ServerConfig;
}

let configAtom: Atom.Writable<ServerConfig | null>;
let registry: AtomRegistry.AtomRegistry;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  configAtom = Atom.make<ServerConfig | null>(config({}));
  fixture.configs = new Map<string, unknown>([
    [env, configAtom],
    [otherEnv, Atom.make<ServerConfig | null>(config({}))],
  ]);
  registry = AtomRegistry.make();
});

function renderIndicator(environmentId = env) {
  return renderDom(
    createElement(
      RegistryContext.Provider,
      { value: registry },
      createElement(SidebarThreadSubagentIndicator, { environmentId, threadId: thread }),
    ),
  );
}

const indicator = (view: Awaited<ReturnType<typeof renderIndicator>>) =>
  view.find('[aria-label="Subagents set to Cursor"]');

describe("sidebar row Cursor indicator", () => {
  it("shows while the thread is set to Cursor, and goes when it is set back", async () => {
    registry.set(configAtom, config({ [thread]: "on" }));
    const view = await renderIndicator();
    expect(indicator(view)).not.toBeNull();

    await act(async () => registry.set(configAtom, config({ [thread]: "inherit" })));
    expect(indicator(view)).toBeNull();
  });

  it("reads the thread's own environment", async () => {
    registry.set(configAtom, config({ [thread]: "on" }));
    const view = await renderIndicator(otherEnv);
    expect(indicator(view)).toBeNull();
  });

  // The environment's shared readiness reaches each row: with Cursor's usage used up and
  // spending off, the server will not offload, so the row claims nothing.
  it("hides while Cursor credits are used up", async () => {
    const full = {
      instanceId: "cursor",
      driver: "cursor",
      enabled: true,
      usageLimits: {
        checkedAt: "2026-10-09T00:00:00.000Z",
        windows: [{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }],
      },
    };
    registry.set(configAtom, config({ [thread]: "on" }, [full]));
    const view = await renderIndicator();
    expect(indicator(view)).toBeNull();
  });
});

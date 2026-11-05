import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, renderDom } from "../../testing/renderDom";

const refreshProviders = vi.fn(async () => undefined);

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => refreshProviders }));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { refreshProviders: null },
    primaryServerEnvironmentThemesAtom: Atom.make([]),
  };
});
const useHostMetrics = vi.fn();
vi.mock("~/hooks/useHostMetrics", () => ({ useHostMetrics }));

const { VitalsGaugeConnected } = await import("./VitalsGauge");

const instanceId = ProviderInstanceId.make("claudeAgent");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-03T07:13:35.424Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-10-03T07:13:37.215Z",
    windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 99 }],
  },
};

describe("VitalsGaugeConnected usage refresh", () => {
  it("asks the server to bypass the instance's probe cache", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const view = await renderDom(
      <VitalsGaugeConnected
        environmentId={environmentId}
        context={null}
        usageProvider={provider}
      />,
    );
    expect(useHostMetrics).not.toHaveBeenCalled();
    await view.click(view.find("button"));
    expect(view.text()).not.toContain("Machine");
    const refresh = document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh usage from the provider"]',
    );
    expect(refresh).not.toBeNull();
    await act(async () => {
      refresh?.click();
    });
    expect(refreshProviders).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, fresh: true },
    });
  });
});

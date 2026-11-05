import type { ResourceQueueItem, ResourceQueueSnapshot } from "@t3tools/contracts";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostMetricsSample } from "~/lib/hostMetrics";

/**
 * The multi-environment panel: one section per enabled environment, each with a usage part
 * (host metrics) and a reservations part (resctl). Every hook it reads is mocked, so each test
 * pins one rule of the panel itself.
 */

type Phase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

interface Summary {
  environmentId: string;
  environmentLabel: string;
  isEnabled: boolean;
  connectionState: Phase;
}
interface View<A> {
  data: A | null;
  status: "ok" | "unsupported" | "failed";
  message: string | null;
  receivedAt: number;
}

interface HostView {
  sample: HostMetricsSample | null;
  status: "ok" | "unsupported" | "failed";
  message: string | null;
  receivedAt: number;
}

const state = vi.hoisted(() => ({
  primary: "env-a" as string | null,
  summaries: [] as Summary[],
  queues: new Map<string, View<ResourceQueueSnapshot>>(),
  hosts: new Map<string, HostView>(),
}));

const clock = vi.hoisted(() => {
  let now = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => now,
    set: (next: number) => {
      now = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const hostCalls = vi.hoisted(() => [] as Array<[string, boolean]>);
const queueCalls = vi.hoisted(
  () => [] as Array<[ReadonlyArray<{ environmentId: string; connected: boolean }>, boolean]>,
);

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.primary,
  useEnvironmentConnectionSummaries: () => state.summaries,
}));
vi.mock("../../hooks/useResourceQueues", () => ({
  useResourceQueues: (
    envs: ReadonlyArray<{ environmentId: string; connected: boolean }>,
    fast: boolean,
  ) => {
    queueCalls.push([envs, fast]);
    return envs.map(
      (env) =>
        state.queues.get(env.environmentId) ?? {
          data: null,
          status: "ok",
          message: null,
          receivedAt: 0,
        },
    );
  },
}));
vi.mock("../../hooks/useHostMetrics", () => ({
  useHostMetrics: (environmentId: string, active: boolean) => {
    hostCalls.push([environmentId, active]);
    return (
      (active ? state.hosts.get(environmentId) : undefined) ?? {
        sample: null,
        status: "ok",
        message: null,
        receivedAt: 0,
      }
    );
  },
}));
vi.mock("../../hooks/useNowSecond", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useNowSecond: () => useSyncExternalStore(clock.subscribe, clock.get, clock.get) };
});

import { SidebarResourceQueue } from "./SidebarResourceQueue";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { act, renderDom } from "../../testing/renderDom";

const NOW = 1_000_000_000;
// Printed in the header: a label with every character that could break quoting or layout.
const HOSTILE_LABEL = "-mac $studio | [lab]* x\nrack";

function item(over: Partial<ResourceQueueItem>): ResourceQueueItem {
  return {
    resource: "cpu_perf",
    state: "running",
    priority: "normal",
    reason: "job",
    project: "t3code",
    amount: 1,
    sinceMs: NOW - 30_000,
    ...over,
  };
}

function snapshot(over: Partial<ResourceQueueSnapshot> = {}): ResourceQueueSnapshot {
  return {
    ts: NOW,
    available: true,
    maintenance: false,
    resources: [],
    running: [],
    waiting: [],
    ...over,
  };
}

function ok<A>(data: A, receivedAt = NOW): View<A> {
  return { data, status: "ok", message: null, receivedAt };
}

function sample(over: Partial<HostMetricsSample> = {}): HostMetricsSample {
  return {
    ts: NOW,
    cpu: { pct: 6, perCore: [], loadAvg: [] },
    mem: { usedBytes: 1, totalBytes: 2, pct: 19 },
    gpu: null,
    disks: [
      { mount: "/", usedBytes: 1, totalBytes: 2, pct: 44, readAt: NOW },
      { mount: "/data", usedBytes: 1, totalBytes: 2, pct: 94, readAt: NOW },
    ],
    ...over,
  };
}

function env(environmentId: string, over: Partial<Summary> = {}): Summary {
  return {
    environmentId,
    environmentLabel: environmentId,
    isEnabled: true,
    connectionState: "connected",
    ...over,
  };
}

const OPEN = { isOpen: true, onOpenChange: () => {} };
const CLOSED = { isOpen: false, onOpenChange: () => {} };

function render(props: { isOpen: boolean; onOpenChange: (open: boolean) => void } = OPEN) {
  return renderDom(
    createElement(
      SidebarProvider,
      null,
      createElement(SidebarMenu, null, createElement(SidebarResourceQueue, props)),
    ),
  );
}

type PanelView = Awaited<ReturnType<typeof render>>;

const section = (view: PanelView, id: string) => view.find(`[data-env="${id}"]`);
const sectionText = (view: PanelView, id: string) => section(view, id)?.textContent ?? "";
const foldButton = (view: PanelView, id: string, part: string) =>
  section(view, id)?.querySelector(`[data-fold="${part}"]`) ?? null;

beforeEach(() => {
  window.localStorage.clear();
  state.primary = "env-a";
  state.summaries = [];
  state.queues = new Map();
  state.hosts = new Map();
  hostCalls.length = 0;
  queueCalls.length = 0;
  clock.set(NOW);
});

describe("which environments are listed", () => {
  it("lists enabled environments, primary first with a local tag, and drops disabled ones", async () => {
    state.summaries = [
      env("env-b", { environmentLabel: HOSTILE_LABEL }),
      env("env-a", { environmentLabel: "long-aorus" }),
      env("env-off", { isEnabled: false }),
    ];
    const view = await render();
    const order = view.findAll("[data-env]").map((node) => node.getAttribute("data-env"));
    expect(order).toEqual(["env-a", "env-b"]);
    expect(sectionText(view, "env-a")).toContain("long-aorus");
    expect(sectionText(view, "env-b")).toContain(HOSTILE_LABEL);
    expect(section(view, "env-a")?.querySelector("[data-local]")?.textContent).toBe("local");
    expect(section(view, "env-b")?.querySelector("[data-local]")).toBeNull();
    // The disabled env is never polled either.
    expect(queueCalls.at(-1)?.[0].map((entry) => entry.environmentId)).toEqual(["env-a", "env-b"]);
  });

  it("tells the poller which environments are connected and whether the panel is open", async () => {
    state.summaries = [env("env-a"), env("env-b", { connectionState: "reconnecting" })];
    await render(CLOSED);
    expect(queueCalls.at(-1)).toEqual([
      [
        { environmentId: "env-a", connected: true },
        { environmentId: "env-b", connected: false },
      ],
      false,
    ]);
    await render(OPEN);
    expect(queueCalls.at(-1)?.[1]).toBe(true);
  });
});

describe("trigger badges", () => {
  it("totals running and waiting across environments, excluding the ram pool", async () => {
    state.summaries = [env("env-a"), env("env-b", { connectionState: "reconnecting" })];
    state.queues.set(
      "env-a",
      ok(snapshot({ running: [item({}), item({ resource: "ram", pid: 9 })] })),
    );
    state.queues.set(
      "env-b",
      ok(
        snapshot({
          running: [item({ pid: 2 }), item({ pid: 3 })],
          waiting: [
            item({ state: "waiting", pos: 1 }),
            item({ state: "waiting", resource: "ram" }),
          ],
        }),
      ),
    );
    const view = await render(CLOSED);
    expect(view.find('[aria-label="3 running (holding a lease)"]')).not.toBeNull();
    expect(view.find('[aria-label="1 waiting (queued)"]')).not.toBeNull();
    expect(view.find('[aria-label="broker in maintenance (draining)"]')).toBeNull();
  });

  it("shows maint when any environment is in maintenance", async () => {
    state.summaries = [env("env-a"), env("env-b")];
    state.queues.set("env-a", ok(snapshot()));
    state.queues.set("env-b", ok(snapshot({ maintenance: true })));
    const view = await render(CLOSED);
    expect(view.find('[aria-label="broker in maintenance (draining)"]')).not.toBeNull();
  });
});

describe("per-environment states", () => {
  it("I7: an unsupported env says so in both parts while another env renders pools and jobs", async () => {
    state.summaries = [env("env-a"), env("env-b")];
    state.queues.set("env-a", {
      data: null,
      status: "unsupported",
      message: "Unknown request tag: resourceQueue.get",
      receivedAt: 0,
    });
    state.hosts.set("env-a", {
      sample: null,
      status: "unsupported",
      message: "Unknown request tag: subscribeHostMetrics",
      receivedAt: 0,
    });
    state.queues.set(
      "env-b",
      ok(
        snapshot({
          resources: [
            { name: "cpu_perf", capacity: 12, inUse: 8 },
            { name: "ram", capacity: 64, inUse: 9, advisory: true },
          ],
          running: [item({ reason: "t3code verify gate" })],
        }),
      ),
    );
    const view = await render();
    const a = sectionText(view, "env-a");
    expect(a.split("Not available on this server")).toHaveLength(3);
    expect(a).not.toContain("Unknown request tag");
    const b = sectionText(view, "env-b");
    expect(b).toContain("cpu_perf");
    expect(b).toContain("t3code verify gate");
    expect(b).not.toContain("Not available on this server");
    // The advisory ram pool is never drawn.
    const pools = [...(section(view, "env-b")?.querySelectorAll(".grid span.uppercase") ?? [])];
    expect(pools.map((node) => node.textContent)).toEqual(["cpu_perf"]);
  });

  it("R7: an unsupported env shows no badges and is not opened as busy", async () => {
    state.summaries = [env("env-a"), env("env-b")];
    state.queues.set("env-b", {
      data: snapshot({ running: [item({ pid: 7 })] }),
      status: "unsupported",
      message: "Unknown request tag: resourceQueue.get",
      receivedAt: NOW,
    });
    const view = await render();
    // Not primary, and its stale job does not count: it starts collapsed.
    expect(foldButton(view, "env-b", "machine")?.getAttribute("aria-expanded")).toBe("false");
    expect(
      section(view, "env-b")?.querySelector('[aria-label$="running (holding a lease)"]'),
    ).toBeNull();
    // The trigger total is unchanged: it still counts every env with data.
    expect(view.find('[aria-label="1 running (holding a lease)"]')).not.toBeNull();
  });

  it("an env that became unsupported hides its stale jobs behind the unsupported text", async () => {
    state.summaries = [env("env-a")];
    state.queues.set("env-a", {
      data: snapshot({ running: [item({ reason: "stale job" })] }),
      status: "unsupported",
      message: "Unknown request tag: resourceQueue.get",
      receivedAt: NOW,
    });
    const view = await render();
    expect(sectionText(view, "env-a")).toContain("Not available on this server");
    expect(sectionText(view, "env-a")).not.toContain("stale job");
  });

  it("shows a failed env's message", async () => {
    state.summaries = [env("env-a")];
    state.queues.set("env-a", {
      data: null,
      status: "failed",
      message: "Missing scope orchestration:read",
      receivedAt: 0,
    });
    const view = await render();
    expect(sectionText(view, "env-a")).toContain("Missing scope orchestration:read");
  });

  it("says Request failed for a failed env with no message", async () => {
    state.summaries = [env("env-a")];
    state.queues.set("env-a", { data: null, status: "failed", message: null, receivedAt: 0 });
    const view = await render();
    expect(sectionText(view, "env-a")).toContain("Request failed");
  });

  it("keeps the error in the folded summary of a failed env that kept its data", async () => {
    state.summaries = [env("env-a")];
    state.queues.set("env-a", {
      data: snapshot({ running: [item({})] }),
      status: "failed",
      message: "socket closed",
      receivedAt: NOW,
    });
    const view = await render();
    await view.click(foldButton(view, "env-a", "reservations"));
    expect(sectionText(view, "env-a")).toContain("1 running · 0 waiting · socket closed");
  });

  it("keeps a failed env's last data on screen beside its message", async () => {
    state.summaries = [env("env-a")];
    state.queues.set("env-a", {
      data: snapshot({ running: [item({ reason: "still here" })] }),
      status: "failed",
      message: "socket closed",
      receivedAt: NOW,
    });
    const view = await render();
    const text = sectionText(view, "env-a");
    expect(text).toContain("still here");
    expect(text).toContain("socket closed");
  });

  it("names why the broker is unavailable, and says unknown without a reason", async () => {
    state.summaries = [env("env-a"), env("env-b")];
    state.queues.set(
      "env-a",
      ok(
        snapshot({
          available: false,
          unavailableReason: "broker not running (daemon_unreachable)",
        }),
      ),
    );
    state.queues.set("env-b", ok(snapshot({ available: false })));
    state.primary = "env-a";
    const view = await render();
    expect(sectionText(view, "env-a")).toContain(
      "Resource broker unavailable: broker not running (daemon_unreachable)",
    );
    // env-b is not primary and has no jobs, so it starts collapsed; open it.
    await view.click(foldButton(view, "env-b", "machine"));
    expect(sectionText(view, "env-b")).toContain("Resource broker unavailable: unknown");
  });

  it("dims a disconnected env with data, shows its phase, and freezes elapsed at receipt", async () => {
    state.summaries = [env("env-a"), env("env-b", { connectionState: "reconnecting" })];
    state.queues.set("env-a", ok(snapshot({ running: [item({ sinceMs: NOW - 30_000 })] })));
    state.queues.set(
      "env-b",
      ok(
        snapshot({ running: [item({ reason: "frozen job", sinceMs: NOW - 200_000 })] }),
        NOW - 80_000,
      ),
    );
    const view = await render();
    expect(section(view, "env-b")?.className).toContain("opacity-60");
    expect(section(view, "env-a")?.className).not.toContain("opacity-60");
    expect(sectionText(view, "env-b")).toContain("Reconnecting");
    expect(sectionText(view, "env-a")).not.toContain("Reconnecting");
    expect(sectionText(view, "env-a")).not.toContain("Connected");
    // Frozen at receivedAt − sinceMs = 120 s, not now − sinceMs = 200 s.
    expect(sectionText(view, "env-b")).toContain("running 2m");
    expect(sectionText(view, "env-a")).toContain("running 30s");

    await act(() => clock.set(NOW + 120_000));
    expect(sectionText(view, "env-b")).toContain("running 2m");
    expect(sectionText(view, "env-a")).toContain("running 2m");
    await act(() => clock.set(NOW + 300_000));
    expect(sectionText(view, "env-b")).toContain("running 2m");
    expect(sectionText(view, "env-a")).toContain("running 5m");
  });

  it("shows only the header and phase for a disconnected env without data", async () => {
    state.summaries = [env("env-a", { connectionState: "offline" })];
    const view = await render();
    expect(sectionText(view, "env-a")).toContain("env-a");
    expect(sectionText(view, "env-a")).toContain("Offline");
    expect(foldButton(view, "env-a", "usage")).toBeNull();
    expect(foldButton(view, "env-a", "reservations")).toBeNull();
    expect(sectionText(view, "env-a")).not.toContain("cpu");
  });

  it("names every connection phase in the header", async () => {
    const phases: Array<[Phase, string]> = [
      ["available", "Not connected"],
      ["offline", "Offline"],
      ["connecting", "Connecting"],
      ["reconnecting", "Reconnecting"],
      ["error", "Connection failed"],
      ["unsupported", "Client not supported"],
    ];
    state.summaries = phases.map(([phase]) => env(phase, { connectionState: phase }));
    state.primary = null;
    const view = await render();
    for (const [phase, text] of phases) expect(sectionText(view, phase)).toContain(text);
  });
});

describe("machine header", () => {
  it("names the machine, its phase and its counts", async () => {
    state.summaries = [
      env("env-a", { environmentLabel: HOSTILE_LABEL }),
      env("env-b", { connectionState: "offline" }),
      env("env-c"),
    ];
    state.queues.set(
      "env-a",
      ok(snapshot({ running: [item({}), item({ resource: "ram" })], waiting: [] })),
    );
    state.queues.set("env-c", {
      data: null,
      status: "unsupported",
      message: "Unknown request tag: resourceQueue.get",
      receivedAt: 0,
    });
    const view = await render();
    const label = (id: string) => foldButton(view, id, "machine")?.getAttribute("aria-label");
    expect(label("env-a")).toBe(`${HOSTILE_LABEL}, local, connected, 1 running, 0 waiting`);
    // No list, no counts: an offline env without data and an unsupported env.
    expect(label("env-b")).toBe("env-b, Offline");
    expect(label("env-c")).toMatch(/^env-c, connected, cpu \S+, mem \S+, disk \S+, not available$/);
  });

  it("speaks what a collapsed header shows: local, quick stats, no broker", async () => {
    state.summaries = [env("env-a"), env("env-b")];
    state.queues.set("env-a", ok(snapshot()));
    state.queues.set("env-b", ok(snapshot({ available: false })));
    const view = await render();
    const label = (id: string) => foldButton(view, id, "machine")?.getAttribute("aria-label");
    // Open: the quick stats and "no broker" are not on screen, so not in the name.
    await view.click(foldButton(view, "env-b", "machine"));
    expect(label("env-b")).not.toContain("no broker");
    expect(label("env-b")).not.toContain("cpu");
    await view.click(foldButton(view, "env-b", "machine"));
    await view.click(foldButton(view, "env-a", "machine"));
    expect(label("env-a")).toMatch(/^env-a, local, connected, cpu \S+, mem \S+, disk \S+, /);
    expect(label("env-b")).toMatch(/^env-b, connected, cpu \S+, mem \S+, disk \S+, no broker$/);
    expect(label("env-b")).not.toContain("local");
    // A live dot and a stale disk are on screen too, so both are in the name.
    expect(label("env-a")).not.toContain("live");
    expect(label("env-a")).not.toContain("stale");
    const staleDisks = [{ mount: "/", usedBytes: 1, totalBytes: 2, pct: 55, readAt: NOW - 61_000 }];
    state.hosts.set("env-a", {
      sample: sample({ disks: staleDisks }),
      status: "ok",
      message: null,
      receivedAt: NOW,
    });
    const liveView = await render();
    expect(foldButton(liveView, "env-a", "machine")?.getAttribute("aria-label")).toMatch(
      /^env-a, local, connected, live, cpu \S+, mem \S+, disk 55 stale, /,
    );
  });

  it("an env with nothing to show stays focusable but does not fold", async () => {
    state.summaries = [env("env-a", { connectionState: "offline" })];
    const view = await render();
    const header = foldButton(view, "env-a", "machine") as HTMLButtonElement;
    expect(header.disabled).toBe(false);
    expect(header.getAttribute("aria-disabled")).toBe("true");
    await view.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("t3code:resource-queue-folds")).toBeNull();
    // A machine with a body is not marked disabled.
    state.summaries = [env("env-a")];
    const live = await render();
    expect(foldButton(live, "env-a", "machine")?.hasAttribute("aria-disabled")).toBe(false);
  });

  it("each fold button controls the region it opens", async () => {
    state.summaries = [env("env-a"), env("env-b")];
    state.queues.set("env-a", ok(snapshot()));
    state.hosts.set("env-a", { sample: sample(), status: "ok", message: null, receivedAt: NOW });
    const view = await render();
    const ids = new Set<string>();
    for (const part of ["machine", "usage", "reservations"]) {
      const id = foldButton(view, "env-a", part)?.getAttribute("aria-controls") ?? "";
      expect(id).not.toBe("");
      ids.add(id);
      expect(section(view, "env-a")?.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
    expect(ids.size).toBe(3);
    // A folded part controls nothing that is on screen.
    expect(foldButton(view, "env-b", "machine")?.hasAttribute("aria-controls")).toBe(false);
    await view.click(foldButton(view, "env-a", "usage"));
    expect(foldButton(view, "env-a", "usage")?.hasAttribute("aria-controls")).toBe(false);
  });

  it("count badges are labelled images", async () => {
    state.summaries = [env("env-a")];
    state.queues.set("env-a", ok(snapshot({ maintenance: true })));
    const view = await render(CLOSED);
    for (const name of [
      "0 running (holding a lease)",
      "0 waiting (queued)",
      "broker in maintenance (draining)",
    ]) {
      expect(view.find(`[aria-label="${name}"]`)?.getAttribute("role")).toBe("img");
    }
  });
});

describe("job rows", () => {
  it("two pid-less leases on one pool are separate rows", async () => {
    state.summaries = [env("env-a")];
    state.queues.set(
      "env-a",
      ok(
        snapshot({
          running: [
            item({ reason: "first", sinceMs: NOW - 10_000 }),
            item({ reason: "second", sinceMs: NOW - 20_000 }),
          ],
        }),
      ),
    );
    const view = await render();
    const rows = () => [...(section(view, "env-a")?.querySelectorAll('[role="button"]') ?? [])];
    expect(rows().map((row) => row.textContent?.includes("first"))).toEqual([true, false]);
    await view.click(rows()[0]!);
    expect(rows().map((row) => row.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
  });

  it("an unknown or prototype-named priority gets the fallback badge", async () => {
    state.summaries = [env("env-a")];
    state.queues.set(
      "env-a",
      ok(
        snapshot({
          running: [
            item({ priority: "constructor", pid: 1 }),
            item({ priority: "__proto__", pid: 2 }),
            item({ priority: "interactive", pid: 3 }),
          ],
        }),
      ),
    );
    const view = await render();
    const tags = ["constructor", "__proto__", "interactive"].map((priority) =>
      [...(section(view, "env-a")?.querySelectorAll("span.uppercase") ?? [])].find(
        (node) => node.textContent === priority,
      ),
    );
    expect(tags.map((tag) => tag?.className.includes("bg-muted text-muted-foreground"))).toEqual([
      true,
      true,
      false,
    ]);
    expect(tags[2]?.className).toContain("bg-rose-400/15");
  });
});

describe("host metrics", () => {
  it("I5: subscribes only while open, and only for connected envs", async () => {
    state.summaries = [env("env-a"), env("env-b", { connectionState: "reconnecting" })];
    state.queues.set("env-b", ok(snapshot()));
    const closed = await render(CLOSED);
    expect(hostCalls.filter(([, active]) => active)).toEqual([]);
    await closed.unmount();

    const view = await render(OPEN);
    expect(hostCalls.filter(([, active]) => active).map(([id]) => id)).toContain("env-a");
    expect(hostCalls.filter(([id, active]) => id === "env-b" && active)).toEqual([]);
    expect(hostCalls.some(([id, active]) => id === "env-b" && !active)).toBe(true);

    hostCalls.length = 0;
    await view.rerender(
      createElement(
        SidebarProvider,
        null,
        createElement(SidebarMenu, null, createElement(SidebarResourceQueue, CLOSED)),
      ),
    );
    await act(() => clock.set(NOW + 5_000));
    expect(hostCalls.filter(([, active]) => active)).toEqual([]);
  });

  it("I13: live is on with a sample under 10 s old and off 11 s later", async () => {
    state.summaries = [env("env-a")];
    state.hosts.set("env-a", {
      sample: sample(),
      status: "ok",
      message: null,
      receivedAt: NOW - 1_000,
    });
    const view = await render();
    expect(section(view, "env-a")?.querySelector("[data-live]")).not.toBeNull();
    await act(() => clock.set(NOW + 8_000));
    expect(section(view, "env-a")?.querySelector("[data-live]")).not.toBeNull();
    await act(() => clock.set(NOW + 11_000));
    expect(section(view, "env-a")?.querySelector("[data-live]")).toBeNull();
  });

  it("N1 a sample under 10 000 ms old is live; exactly 10 000 ms old is not", async () => {
    state.summaries = [env("env-a")];
    state.hosts.set("env-a", { sample: sample(), status: "ok", message: null, receivedAt: NOW });
    const view = await render();
    const live = () => section(view, "env-a")?.querySelector("[data-live]") != null;
    const name = () => foldButton(view, "env-a", "machine")?.getAttribute("aria-label") ?? "";
    await act(() => clock.set(NOW + 9_999));
    expect([live(), name().includes(", live")]).toEqual([true, true]);
    await act(() => clock.set(NOW + 10_000));
    expect([live(), name().includes(", live")]).toEqual([false, false]);
    await act(() => clock.set(NOW + 10_001));
    expect([live(), name().includes(", live")]).toEqual([false, false]);
  });

  it("says usage is unavailable with the failure text", async () => {
    state.summaries = [env("env-a")];
    state.hosts.set("env-a", {
      sample: null,
      status: "failed",
      message: "stream ended",
      receivedAt: 0,
    });
    const view = await render();
    expect(sectionText(view, "env-a")).toContain("Usage unavailable: stream ended");
  });

  it("says usage is unavailable for a disconnected env that still shows its queue", async () => {
    state.summaries = [env("env-a", { connectionState: "reconnecting" })];
    state.queues.set("env-a", ok(snapshot()));
    const view = await render();
    expect(sectionText(view, "env-a")).toContain("Usage unavailable");
  });
});

describe("folds", () => {
  function busyFixture() {
    state.summaries = [env("env-a"), env("env-b")];
    state.queues.set("env-a", ok(snapshot()));
    state.queues.set(
      "env-b",
      ok(
        snapshot({
          running: [item({ pid: 1 }), item({ pid: 2 }), item({ pid: 3, resource: "ram" })],
          waiting: [
            item({ state: "waiting", pos: 1 }),
            item({ state: "waiting", resource: "ram" }),
          ],
        }),
      ),
    );
    state.hosts.set("env-a", { sample: sample(), status: "ok", message: null, receivedAt: NOW });
  }

  it("opens the primary and busy machines by default and collapses an idle remote", async () => {
    state.summaries = [env("env-a"), env("env-b"), env("env-c")];
    state.queues.set("env-b", ok(snapshot({ waiting: [item({ state: "waiting", pos: 1 })] })));
    const view = await render();
    expect(foldButton(view, "env-a", "machine")?.getAttribute("aria-expanded")).toBe("true");
    expect(foldButton(view, "env-b", "machine")?.getAttribute("aria-expanded")).toBe("true");
    expect(foldButton(view, "env-c", "machine")?.getAttribute("aria-expanded")).toBe("false");
    expect(foldButton(view, "env-c", "usage")).toBeNull();
  });

  it("folds usage to its one-line summary", async () => {
    busyFixture();
    const view = await render();
    expect(sectionText(view, "env-a")).toContain("CPU");
    await view.click(foldButton(view, "env-a", "usage"));
    expect(foldButton(view, "env-a", "usage")?.getAttribute("aria-expanded")).toBe("false");
    const text = sectionText(view, "env-a");
    expect(text).toContain("cpu 6 · gpu - · mem 19 · disk 94");
    expect(text).not.toContain("CPU");
    // Each value carries the shared severity colour: the 94% disk is red, the 6% cpu green.
    const line = section(view, "env-a")?.querySelector("[data-usage-summary]");
    expect(line?.querySelector(".text-red-500")?.textContent).toBe("94");
    expect(line?.querySelector(".text-green-500")?.textContent).toBe("6");
  });

  it("folded usage shows a gpu reading when present and a dash with no disks", async () => {
    state.summaries = [env("env-a")];
    state.hosts.set("env-a", {
      sample: sample({ gpu: { pct: 44.2 }, disks: [] }),
      status: "ok",
      message: null,
      receivedAt: NOW,
    });
    const view = await render();
    await view.click(foldButton(view, "env-a", "usage"));
    const line = section(view, "env-a")?.querySelector("[data-usage-summary]");
    expect(line?.textContent).toBe("cpu 6 · gpu 44 · mem 19 · disk -");
  });

  it("dims the folded and collapsed disk number when the fullest disk is stale", async () => {
    busyFixture();
    const staleDisks = [
      { mount: "/", usedBytes: 1, totalBytes: 2, pct: 44, readAt: NOW },
      { mount: "/data", usedBytes: 1, totalBytes: 2, pct: 94, readAt: NOW - 61_000 },
    ];
    state.hosts.set("env-a", {
      sample: sample({ disks: staleDisks }),
      status: "ok",
      message: null,
      receivedAt: NOW,
    });
    const view = await render();
    await view.click(foldButton(view, "env-a", "usage"));
    const line = section(view, "env-a")?.querySelector("[data-usage-summary]");
    const dimmed = line?.querySelectorAll(".opacity-50");
    expect(dimmed).toHaveLength(1);
    expect(dimmed?.[0]?.textContent).toBe("disk 94");
    await view.click(foldButton(view, "env-a", "machine"));
    const quick = section(view, "env-a")?.querySelector("[data-quick]");
    expect(quick?.querySelectorAll(".opacity-50")).toHaveLength(1);
    expect(quick?.querySelector(".opacity-50")?.textContent).toBe("disk 94");
  });

  it("folds reservations to their counts", async () => {
    busyFixture();
    const view = await render();
    await view.click(foldButton(view, "env-b", "reservations"));
    expect(sectionText(view, "env-b")).toContain("2 running · 1 waiting");
    expect(section(view, "env-b")?.querySelectorAll('[role="button"]')).toHaveLength(0);
  });

  it("folds reservations to the broker state when the broker is down", async () => {
    state.summaries = [env("env-a")];
    state.queues.set(
      "env-a",
      ok(snapshot({ available: false, unavailableReason: "resctl timed out after 2 s" })),
    );
    const view = await render();
    await view.click(foldButton(view, "env-a", "reservations"));
    expect(sectionText(view, "env-a")).toContain(
      "Resource broker unavailable: resctl timed out after 2 s",
    );
  });

  it("collapses a machine to cpu, mem and disk numbers with its badges", async () => {
    busyFixture();
    const view = await render();
    await view.click(foldButton(view, "env-a", "machine"));
    const quick = section(view, "env-a")?.querySelector("[data-quick]");
    expect(quick?.textContent).toBe("cpu 6mem 19disk 94");
    // Stats sit on their own line, never inside the first-line row that holds the name.
    const headerRow = section(view, "env-a")?.querySelector("[data-header-row]");
    expect(headerRow).not.toBeNull();
    expect(headerRow?.contains(quick ?? null)).toBe(false);
    expect(quick?.parentElement).toBe(headerRow?.parentElement);
    // The fullest disk is coloured by the shared severity scale (94 → crit).
    expect(quick?.querySelector(".text-red-500")?.textContent).toBe("94");
    expect(foldButton(view, "env-a", "usage")).toBeNull();
    expect(
      section(view, "env-b")?.querySelector('[aria-label="2 running (holding a lease)"]'),
    ).not.toBeNull();
  });

  it("a fold keeps the overrides of disabled environments", async () => {
    state.summaries = [env("env-a"), env("env-off", { isEnabled: false })];
    window.localStorage.setItem(
      "t3code:resource-queue-folds",
      JSON.stringify({ '["env-off","usage"]': false, '["env-gone","usage"]': false }),
    );
    const view = await render();
    await view.click(foldButton(view, "env-a", "usage"));
    expect(JSON.parse(window.localStorage.getItem("t3code:resource-queue-folds")!)).toEqual({
      '["env-off","usage"]': false,
      '["env-a","usage"]': false,
    });
  });

  it("remembers folds across a remount", async () => {
    busyFixture();
    const first = await render();
    await first.click(foldButton(first, "env-a", "usage"));
    await first.click(foldButton(first, "env-b", "machine"));
    await first.unmount();
    expect(window.localStorage.getItem("t3code:resource-queue-folds")).not.toBeNull();

    const second = await render();
    expect(foldButton(second, "env-a", "usage")?.getAttribute("aria-expanded")).toBe("false");
    expect(foldButton(second, "env-b", "machine")?.getAttribute("aria-expanded")).toBe("false");
    expect(foldButton(second, "env-a", "reservations")?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("footer", () => {
  it("counts totals and reachable environments", async () => {
    state.summaries = [env("env-a"), env("env-b", { connectionState: "offline" }), env("env-c")];
    state.queues.set(
      "env-a",
      ok(snapshot({ running: [item({})], waiting: [item({ state: "waiting", pos: 1 })] })),
    );
    const view = await render();
    expect(view.find("[data-footer-counts]")?.textContent).toBe(
      "1 running · 1 waiting · 2 of 3 reachable",
    );
  });

  it("collapse all closes every machine, then expand busy opens only those with jobs", async () => {
    state.summaries = [env("env-a"), env("env-b"), env("env-c")];
    state.queues.set("env-a", ok(snapshot()));
    state.queues.set("env-b", ok(snapshot({ running: [item({})] })));
    state.queues.set("env-c", ok(snapshot()));
    const view = await render();
    const expandedOf = (id: string) =>
      foldButton(view, id, "machine")?.getAttribute("aria-expanded");
    expect([expandedOf("env-a"), expandedOf("env-b"), expandedOf("env-c")]).toEqual([
      "true",
      "true",
      "false",
    ]);
    expect(view.find("[data-fold-all]")?.textContent).toBe("collapse all");

    await view.click(view.find("[data-fold-all]"));
    expect([expandedOf("env-a"), expandedOf("env-b"), expandedOf("env-c")]).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(view.find("[data-fold-all]")?.textContent).toBe("expand busy");

    await view.click(view.find("[data-fold-all]"));
    expect([expandedOf("env-a"), expandedOf("env-b"), expandedOf("env-c")]).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(view.find("[data-fold-all]")?.textContent).toBe("collapse all");
  });

  it("renders no fold link when it would change nothing", async () => {
    state.summaries = [env("env-a"), env("env-b")];
    state.queues.set("env-a", ok(snapshot()));
    state.queues.set("env-b", ok(snapshot()));
    const view = await render();
    expect(view.find("[data-fold-all]")?.textContent).toBe("collapse all");
    await view.click(view.find("[data-fold-all]"));
    // Everything collapsed and nothing busy: "expand busy" would be a dead button.
    expect(view.find("[data-fold-all]")).toBeNull();
  });

  it("a collapsed machine with its broker down says no broker where the badges go", async () => {
    state.summaries = [env("env-a"), env("env-b"), env("env-c")];
    state.queues.set("env-a", ok(snapshot({ available: false })));
    state.queues.set("env-b", ok(snapshot()));
    state.queues.set("env-c", {
      data: snapshot({ available: false }),
      status: "unsupported",
      message: "Unknown request tag: resourceQueue.get",
      receivedAt: NOW,
    });
    const view = await render();
    // Open, the body names the reason instead.
    expect(section(view, "env-a")?.querySelector("[data-reason]")).toBeNull();
    await view.click(foldButton(view, "env-a", "machine"));
    expect(section(view, "env-a")?.querySelector("[data-reason]")?.textContent).toBe("no broker");
    expect(
      section(view, "env-a")?.querySelector('[aria-label$="running (holding a lease)"]'),
    ).toBeNull();
    // A healthy broker shows badges and no reason.
    expect(section(view, "env-b")?.querySelector("[data-reason]")).toBeNull();
  });

  it("F1 a collapsed machine with no job list says why, in its badge slot and its name", async () => {
    state.summaries = [
      env("env-a"),
      env("env-b", { environmentLabel: HOSTILE_LABEL }),
      env("env-c"),
      env("env-d"),
      env("env-e"),
    ];
    state.queues.set("env-a", ok(snapshot()));
    // An upstream server: unsupported, whatever stale data it kept.
    state.queues.set("env-b", {
      data: snapshot({ available: false }),
      status: "unsupported",
      message: "Unknown request tag: resourceQueue.get",
      receivedAt: NOW,
    });
    // The first request failed: nothing to list.
    state.queues.set("env-c", { data: null, status: "failed", message: "boom", receivedAt: 0 });
    // A later request failed: the last list stays, with its badges.
    state.queues.set("env-d", {
      data: snapshot(),
      status: "failed",
      message: "boom",
      receivedAt: NOW,
    });
    state.queues.set("env-e", ok(snapshot({ available: false })));
    const view = await render();
    const reason = (id: string) =>
      section(view, id)?.querySelector("[data-reason]")?.textContent ?? null;
    const label = (id: string) => foldButton(view, id, "machine")?.getAttribute("aria-label");
    expect(["env-b", "env-c", "env-d", "env-e"].map(reason)).toEqual([
      "not available",
      "request failed",
      null,
      "no broker",
    ]);
    expect(label("env-b")).toMatch(/, not available$/);
    expect(label("env-b")?.startsWith(`${HOSTILE_LABEL}, connected, `)).toBe(true);
    expect(label("env-c")).toMatch(
      /^env-c, connected, cpu \S+, mem \S+, disk \S+, request failed$/,
    );
    expect(label("env-d")).toMatch(/, 0 running, 0 waiting$/);
    expect(label("env-d")).not.toContain("failed");
    // Open, the body names the reason in full and the header drops the short one.
    await view.click(foldButton(view, "env-b", "machine"));
    await view.click(foldButton(view, "env-c", "machine"));
    expect([reason("env-b"), reason("env-c")]).toEqual([null, null]);
    expect(label("env-b")).not.toContain("not available");
    expect(label("env-c")).not.toContain("request failed");
    expect(sectionText(view, "env-b")).toContain("Not available on this server");
    expect(sectionText(view, "env-c")).toContain("boom");
  });
});

describe("panel shell", () => {
  it("scrolls its body and anchors above the row", async () => {
    state.summaries = [env("env-a")];
    const view = await render();
    const panel = view.find("#sidebar-resource-queue-panel");
    expect(panel?.classList.contains("bottom-full")).toBe(true);
    const body = panel?.querySelector(".max-h-\\[70vh\\]");
    expect(body?.classList.contains("overflow-y-auto")).toBe(true);
    expect(body?.querySelector('[data-env="env-a"]')).not.toBeNull();
  });
});

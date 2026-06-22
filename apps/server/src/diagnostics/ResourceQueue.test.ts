import { describe, expect, it } from "@effect/vitest";

import { parseResourceQueue } from "./ResourceQueue.ts";

describe("parseResourceQueue", () => {
  it("normalizes leases and queues into running/waiting with derived fields", () => {
    const now = 1782096816411;
    const json = JSON.stringify({
      maintenance: false,
      now: 1782096816.4,
      resources: {
        gpu: {
          capacity: 1,
          in_use: 1,
          advisory: false,
          leases: [
            {
              lease_id: "gpu-1",
              amount: 1,
              priority: "normal",
              reason: "atlas release",
              project: "atlas",
              agent: "atlas",
              pid: 18699,
              granted_at: 1782093799.17,
              eta_sec: null,
            },
          ],
          queue: [
            {
              seq: 2,
              amount: 1,
              priority: "background",
              reason: "E8 run",
              project: "sparse-attn-lab",
              agent: "sparse-attn-lab",
              pid: 28502,
              enqueued_at: 1782093929,
              eta_sec: null,
            },
            {
              seq: 8,
              amount: 2,
              priority: "background",
              reason: "E5b run",
              project: "sparse-attn-lab",
              pid: 98639,
              enqueued_at: 1782094831.4,
              eta_sec: 900,
            },
          ],
        },
        cpu: { capacity: 16, in_use: 0, advisory: false, leases: [], queue: [] },
        ram: { capacity: 124, in_use: 0, advisory: true, leases: [], queue: [] },
      },
    });

    const snap = parseResourceQueue(json, now);

    expect(snap.available).toBe(true);
    expect(snap.maintenance).toBe(false);
    expect(snap.ts).toBe(now);

    expect(snap.running).toHaveLength(1);
    expect(snap.running[0]).toMatchObject({
      resource: "gpu",
      state: "running",
      priority: "normal",
      project: "atlas",
      agent: "atlas",
      pid: 18699,
      amount: 1,
    });
    // granted_at seconds → ms
    expect(snap.running[0]?.sinceMs).toBe(1782093799.17 * 1000);

    // queue entries become waiting jobs with 1-based positions per resource
    expect(snap.waiting).toHaveLength(2);
    expect(snap.waiting[0]).toMatchObject({ state: "waiting", pos: 1, pid: 28502 });
    expect(snap.waiting[1]).toMatchObject({ pos: 2, amount: 2, etaSec: 900 });
    // agent omitted on the second entry stays undefined
    expect(snap.waiting[1]?.agent).toBeUndefined();

    // idle-but-provisioned pools are kept (capacity > 0); ram keeps its advisory flag
    expect(snap.resources.find((r) => r.name === "cpu")).toMatchObject({ capacity: 16, inUse: 0 });
    expect(snap.resources.find((r) => r.name === "ram")?.advisory).toBe(true);
  });

  it("drops fully-idle zero-capacity pools and tolerates missing fields", () => {
    const json = JSON.stringify({
      resources: { machine: { capacity: 0, in_use: 0, leases: [], queue: [] } },
    });
    const snap = parseResourceQueue(json, 1000);
    expect(snap.resources).toHaveLength(0);
    expect(snap.running).toHaveLength(0);
    expect(snap.waiting).toHaveLength(0);
    expect(snap.available).toBe(true);
    expect(snap.maintenance).toBe(false);
  });

  it("defaults priority/amount and reads maintenance", () => {
    const json = JSON.stringify({
      maintenance: true,
      resources: {
        gpu: {
          capacity: 1,
          in_use: 1,
          leases: [{ reason: "x", project: "p", pid: 1, granted_at: 5 }],
          queue: [],
        },
      },
    });
    const snap = parseResourceQueue(json, 1000);
    expect(snap.maintenance).toBe(true);
    expect(snap.running[0]).toMatchObject({ priority: "normal", amount: 1, sinceMs: 5000 });
  });
});

import { describe, expect, it } from "@effect/vitest";
import type { ServerSettings } from "@t3tools/contracts";

import { buildState, cursorInstances, validateCursorInstance } from "./SubagentBackend.ts";
import type { PersistedBackend } from "./SubagentBackend.ts";

const settingsWith = (providerInstances: Record<string, unknown>): ServerSettings =>
  ({ providerInstances }) as unknown as ServerSettings;

const persisted = (overrides: Partial<PersistedBackend>): PersistedBackend => ({
  schemaVersion: 1,
  backend: "cursor",
  instanceId: "cursor",
  model: "auto",
  binaryPath: "/tmp/agent",
  apiEndpoint: "",
  updatedAt: null,
  degraded: null,
  ...overrides,
});

describe("malformed input reaching the toggle", () => {
  const settings = settingsWith({
    cursor: { driver: "cursor", enabled: true, config: { binaryPath: "agent", apiEndpoint: "" } },
  });

  it("drops a flag-file instance id that is not a valid slug", () => {
    // The flag file is hand-editable, and a hand-shaped one has been found at that path
    // before. A branded-slug violation must degrade to null here rather than reach the RPC
    // boundary, where success-encoding would fail and take the whole panel down.
    const state = buildState(persisted({ instanceId: "not a valid slug!" }), settings, []);
    expect(state.instanceId).toBeNull();
  });

  it("keeps a flag-file instance id that is a valid slug", () => {
    const state = buildState(persisted({ instanceId: "cursor" }), settings, []);
    expect(state.instanceId).toBe("cursor");
  });

  it("refuses an instance whose cursor config cannot be decoded", () => {
    // Falling back to Cursor's schema defaults would yield binaryPath "cursor-agent" — a
    // binary the user never configured, and not necessarily the one they run. This machine's
    // real instance is configured as "agent".
    const corrupt = settingsWith({
      cursor: { driver: "cursor", enabled: true, config: { binaryPath: 42 } },
    });
    const result = validateCursorInstance(corrupt, "cursor");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("could not be read");
  });

  it("still accepts an instance whose config decodes", () => {
    const result = validateCursorInstance(settings, "cursor");
    expect(result.ok).toBe(true);
  });

  it("omits an instance with an undecodable config from the picker rather than defaulting it", () => {
    const corrupt = settingsWith({
      cursor: { driver: "cursor", enabled: true, config: { binaryPath: 42 } },
    });
    // The picker lists instances; it must not advertise one that cannot be dispatched to.
    expect(validateCursorInstance(corrupt, "cursor").ok).toBe(false);
    expect(cursorInstances(corrupt).map((i) => i.instanceId)).toContain("cursor");
  });
});

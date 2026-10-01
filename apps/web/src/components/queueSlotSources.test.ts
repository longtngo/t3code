import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { visibleQueueInstanceIds } from "./queueSlotSources";

const provider = (instanceId: string, enabled = true): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId),
  enabled,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

/** The coordinator's input: each environment's server config, keyed by environment. */
const serverConfigs = new Map([
  [
    EnvironmentId.make("env-1"),
    { providers: [provider("codex"), provider("claudeAgent"), provider("opencode", false)] },
  ],
  [EnvironmentId.make("env-2"), { providers: [provider("codex")] }],
]) as unknown as ReadonlyMap<EnvironmentId, ServerConfig>;

describe("visibleQueueInstanceIds", () => {
  it("lists each enabled provider instance once across environments in per-provider mode", () => {
    expect([...visibleQueueInstanceIds(true, serverConfigs)].toSorted()).toEqual([
      "claudeAgent",
      "codex",
    ]);
  });

  it("is empty when the queue counts one global slot pool", () => {
    expect(visibleQueueInstanceIds(false, serverConfigs)).toEqual([]);
  });
});

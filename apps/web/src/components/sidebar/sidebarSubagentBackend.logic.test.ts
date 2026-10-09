import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  SUBAGENT_BACKEND_CURSOR,
  SUBAGENT_BACKEND_DEFAULT,
  type SubagentBackendInstance,
  type ServerProvider,
  type ServerSettings,
  type SubagentBackendState,
  ThreadId,
} from "@t3tools/contracts";

import {
  subagentBackendApplyInput,
  subagentBackendRowStatus,
  subagentCursorAvailable,
  subagentCursorInstancesPickable,
  subagentCursorModelOptions,
  subagentCursorTargetInstanceId,
  subagentTargetSetInput,
  subagentTargetVisible,
  cursorOffloadReadiness,
  offloadedThreadCount,
  threadCursorOffload,
  threadOffloadedToCursor,
  threadOffloadNotes,
} from "./sidebarSubagentBackend.logic";

function instance(instanceId: string): SubagentBackendInstance {
  return {
    instanceId: instanceId as SubagentBackendInstance["instanceId"],
    displayName: instanceId,
  };
}

function state(overrides: Partial<SubagentBackendState>): SubagentBackendState {
  return {
    backend: SUBAGENT_BACKEND_DEFAULT,
    instanceId: null,
    model: null,
    instances: [],
    models: [],
    degraded: null,
    ...overrides,
  };
}

describe("subagentBackendRowStatus", () => {
  it("reads a neutral placeholder before the first get resolves", () => {
    expect(subagentBackendRowStatus(null)).toEqual({ dot: "off", text: "Loading…" });
  });

  it("reads Degraded ahead of everything else, even a live cursor backend", () => {
    expect(
      subagentBackendRowStatus(
        state({
          backend: SUBAGENT_BACKEND_CURSOR,
          instances: [instance("cursor_default")],
          degraded: "corrupt flag file",
        }),
      ),
    ).toEqual({ dot: "off", text: "Degraded" });
  });

  it("reads Cursor unavailable when no enabled instance exists, even if backend says cursor", () => {
    expect(
      subagentBackendRowStatus(state({ backend: SUBAGENT_BACKEND_CURSOR, instances: [] })),
    ).toEqual({ dot: "off", text: "Cursor unavailable" });
  });

  it("reads the selected model's label when cursor is active and the model is known", () => {
    expect(
      subagentBackendRowStatus(
        state({
          backend: SUBAGENT_BACKEND_CURSOR,
          instances: [instance("cursor_default")],
          model: "composer-2.5",
          models: [{ id: "composer-2.5", label: "Composer 2.5" }],
        }),
      ),
    ).toEqual({ dot: "on", text: "Composer 2.5" });
  });

  it("falls back to the raw model id when it isn't in the cached model list", () => {
    expect(
      subagentBackendRowStatus(
        state({
          backend: SUBAGENT_BACKEND_CURSOR,
          instances: [instance("cursor_default")],
          model: "some-new-model",
          models: [],
        }),
      ),
    ).toEqual({ dot: "on", text: "some-new-model" });
  });

  it("reads Auto when cursor is active but no model has been chosen yet", () => {
    expect(
      subagentBackendRowStatus(
        state({ backend: SUBAGENT_BACKEND_CURSOR, instances: [instance("cursor_default")] }),
      ),
    ).toEqual({ dot: "on", text: "Auto" });
  });

  it("reads Default for the default backend", () => {
    expect(
      subagentBackendRowStatus(
        state({ backend: SUBAGENT_BACKEND_DEFAULT, instances: [instance("cursor_default")] }),
      ),
    ).toEqual({ dot: "off", text: "Default" });
  });

  it("greys the dot when the master switch is off, whatever the machine-wide file says", () => {
    // The collapsed row is always mounted, so it is the only thing most users ever see of
    // this feature. Under master-off no T3 thread offloads, and a green dot there is a lie.
    // The text is unchanged: the machine-wide file is still live for non-T3 tools.
    expect(
      subagentBackendRowStatus(
        state({
          backend: SUBAGENT_BACKEND_CURSOR,
          instances: [instance("cursor_default")],
          model: "composer-2.5",
          models: [{ id: "composer-2.5", label: "Composer 2.5" }],
        }),
        undefined,
        false,
      ),
    ).toEqual({ dot: "off", text: "Composer 2.5" });
  });

  it("reads Default for an unrecognised backend value, per the wire contract", () => {
    expect(
      subagentBackendRowStatus(
        state({ backend: "some-future-backend", instances: [instance("cursor_default")] }),
      ),
    ).toEqual({ dot: "off", text: "Default" });
  });
});

describe("subagentCursorAvailable", () => {
  it("is false for null state", () => {
    expect(subagentCursorAvailable(null)).toBe(false);
  });

  it("is false with no enabled instances", () => {
    expect(subagentCursorAvailable(state({ instances: [] }))).toBe(false);
  });

  it("is true with at least one enabled instance", () => {
    expect(subagentCursorAvailable(state({ instances: [instance("cursor_default")] }))).toBe(true);
  });
});

describe("subagentBackendApplyInput", () => {
  it("falls back to the first available instance when switching on from Off — the persisted Off state always has a null instanceId, so this is the only way the toggle can ever turn on", () => {
    const onlyInstance = instance("cursor_default");
    expect(
      subagentBackendApplyInput(
        state({ backend: SUBAGENT_BACKEND_DEFAULT, instances: [onlyInstance] }),
        SUBAGENT_BACKEND_CURSOR,
      ),
    ).toEqual({ backend: SUBAGENT_BACKEND_CURSOR, instanceId: onlyInstance.instanceId });
  });

  it("keeps the already-selected instance when one is already flagged", () => {
    const selected = instance("cursor_personal");
    expect(
      subagentBackendApplyInput(
        state({
          backend: SUBAGENT_BACKEND_CURSOR,
          instanceId: selected.instanceId,
          instances: [instance("cursor_default"), selected],
        }),
        SUBAGENT_BACKEND_CURSOR,
      ),
    ).toEqual({ backend: SUBAGENT_BACKEND_CURSOR, instanceId: selected.instanceId });
  });

  it("omits instanceId when there is no instance to fall back to", () => {
    expect(
      subagentBackendApplyInput(
        state({ backend: SUBAGENT_BACKEND_DEFAULT, instances: [] }),
        SUBAGENT_BACKEND_CURSOR,
      ),
    ).toEqual({ backend: SUBAGENT_BACKEND_CURSOR });
  });

  it("switching to default carries instanceId and model", () => {
    expect(
      subagentBackendApplyInput(
        state({ instanceId: instance("cursor").instanceId, model: "m" }),
        SUBAGENT_BACKEND_DEFAULT,
      ),
    ).toEqual({ backend: SUBAGENT_BACKEND_DEFAULT, instanceId: "cursor", model: "m" });
    expect(
      subagentBackendApplyInput(
        state({ instances: [instance("cursor_default")] }),
        SUBAGENT_BACKEND_DEFAULT,
      ),
    ).toEqual({ backend: SUBAGENT_BACKEND_DEFAULT, instanceId: "cursor_default" });
    expect(subagentBackendApplyInput(state({}), SUBAGENT_BACKEND_DEFAULT)).toEqual({
      backend: SUBAGENT_BACKEND_DEFAULT,
    });
  });
});

describe("subagentCursorInstancesPickable", () => {
  it("is false for null state", () => {
    expect(subagentCursorInstancesPickable(null)).toBe(false);
  });

  it("is false with zero instances", () => {
    expect(subagentCursorInstancesPickable(state({ instances: [] }))).toBe(false);
  });

  it("is false with exactly one instance — nothing to pick between", () => {
    expect(
      subagentCursorInstancesPickable(state({ instances: [instance("cursor_default")] })),
    ).toBe(false);
  });

  it("is true with two or more instances", () => {
    expect(
      subagentCursorInstancesPickable(
        state({ instances: [instance("cursor_default"), instance("cursor_personal")] }),
      ),
    ).toBe(true);
  });
});

describe("subagentCursorModelOptions", () => {
  const cursorState = (overrides: Partial<SubagentBackendState> = {}) =>
    state({
      backend: SUBAGENT_BACKEND_CURSOR,
      instances: [instance("cursor_default")],
      models: [
        { id: "auto", label: "Auto (default)" },
        { id: "claude-opus-5-thinking-high", label: "Claude Opus 5 1M Thinking" },
      ],
      ...overrides,
    });

  it("falls back to the CLI list while the provider snapshot is missing", () => {
    expect(subagentCursorModelOptions(cursorState(), null)).toEqual([
      { id: "auto", label: "Auto (default)" },
      { id: "claude-opus-5-thinking-high", label: "Claude Opus 5 1M Thinking" },
    ]);
  });

  it("offers the provider's visible models instead of the CLI list", () => {
    expect(
      subagentCursorModelOptions(cursorState(), [
        { slug: "claude-opus-5", name: "Claude Opus 5" },
        { slug: "gpt-5.4", name: "GPT-5.4" },
      ]),
    ).toEqual([
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "gpt-5.4", label: "GPT-5.4" },
    ]);
  });

  it("dispatches the provider's Auto under the id the CLI advertises", () => {
    expect(
      subagentCursorModelOptions(cursorState(), [{ slug: "auto-smart", name: "Auto" }]),
    ).toEqual([{ id: "auto", label: "Auto" }]);
  });

  it("keeps a hidden-but-selected model visible so the control is never blank", () => {
    expect(
      subagentCursorModelOptions(cursorState({ model: "claude-opus-5-thinking-high" }), [
        { slug: "gpt-5.4", name: "GPT-5.4" },
      ]),
    ).toEqual([
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "claude-opus-5-thinking-high", label: "Claude Opus 5 1M Thinking" },
    ]);
  });

  it("does not duplicate a selected model the provider still offers", () => {
    expect(
      subagentCursorModelOptions(cursorState({ model: "gpt-5.4" }), [
        { slug: "gpt-5.4", name: "GPT-5.4" },
      ]),
    ).toEqual([{ id: "gpt-5.4", label: "GPT-5.4" }]);
  });

  it("reports an empty picker when the user hid every model", () => {
    expect(subagentCursorModelOptions(cursorState(), [])).toEqual([]);
  });
});

describe("subagentBackendRowStatus model label", () => {
  it("labels the collapsed row from the offered options, not the CLI list", () => {
    const rowState = state({
      backend: SUBAGENT_BACKEND_CURSOR,
      instances: [instance("cursor_default")],
      model: "claude-opus-5",
      models: [{ id: "auto", label: "Auto (default)" }],
    });
    expect(
      subagentBackendRowStatus(rowState, [{ id: "claude-opus-5", label: "Claude Opus 5" }]),
    ).toEqual({ dot: "on", text: "Claude Opus 5" });
  });
});

describe("threadOffloadNotes", () => {
  it("says nothing new when both servers have the master off", () => {
    expect(
      threadOffloadNotes({
        threadMasterEnabled: false,
        primaryMasterEnabled: false,
        cursorAvailable: false,
      }),
    ).toEqual([]);
  });

  it("names the thread's server when only it has the master off", () => {
    expect(
      threadOffloadNotes({
        threadMasterEnabled: false,
        primaryMasterEnabled: true,
        cursorAvailable: null,
      }),
    ).toEqual(["Subagent offload is switched off on this thread's server."]);
  });

  it("points at Settings when Cursor is selectable but no instance exists", () => {
    expect(
      threadOffloadNotes({
        threadMasterEnabled: true,
        primaryMasterEnabled: true,
        cursorAvailable: false,
      }),
    ).toEqual([
      "Add a Cursor instance in Settings to use Cursor here.",
      "Applies to Claude Code threads.",
    ]);
  });

  it("keeps only the provider note when Cursor is available or unknown", () => {
    for (const cursorAvailable of [true, null] as const) {
      expect(
        threadOffloadNotes({
          threadMasterEnabled: true,
          primaryMasterEnabled: true,
          cursorAvailable,
        }),
      ).toEqual(["Applies to Claude Code threads."]);
    }
  });
});

const cursorInstance = { driver: "cursor", enabled: true, config: {} };
const base = {
  subagentBackendEnabled: true,
  allowSpendingCredits: false,
  subagentBackendThreadModes: { a: "on", b: "off", c: "on", gone: "on" },
  providerInstances: { cursor: cursorInstance },
} as unknown as ServerSettings;
const t = (id: string) => ThreadId.make(id);
/** What the server reports for one environment: its settings and its providers. */
const env = (settings: ServerSettings, providers: ReadonlyArray<ServerProvider> = []) => ({
  settings,
  providers,
});
const NOW_MS = Date.parse("2026-10-09T12:00:00.000Z");
/** A Cursor provider whose overall window reads `usedPercent`, resetting at `resetsAt`. */
const cursorProvider = (usedPercent: number, resetsAt = "2026-11-01T00:00:00.000Z") =>
  ({
    instanceId: "cursor",
    driver: "cursor",
    enabled: true,
    usageLimits: {
      checkedAt: "2026-10-09T11:00:00.000Z",
      windows: [
        { id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent, resetsAt },
      ],
    },
  }) as unknown as ServerProvider;

describe("offloaded thread rules", () => {
  it("is true only for mode on, master on, with an enabled cursor instance", () => {
    expect(threadOffloadedToCursor(env(base), t("a"))).toBe(true);
    expect(threadOffloadedToCursor(env(base), t("b"))).toBe(false);
    expect(threadOffloadedToCursor(env(base), t("x"))).toBe(false);
    expect(threadOffloadedToCursor(env({ ...base, subagentBackendEnabled: false }), t("a"))).toBe(
      false,
    );
    expect(
      threadOffloadedToCursor(env({ ...base, providerInstances: {} } as ServerSettings), t("a")),
    ).toBe(false);
    expect(
      threadOffloadedToCursor(
        env({
          ...base,
          providerInstances: { cursor: { ...cursorInstance, enabled: false } },
        } as unknown as ServerSettings),
        t("a"),
      ),
    ).toBe(false);
    expect(threadOffloadedToCursor(null, t("a"))).toBe(false);
  });

  it("is false with only an enabled non-Cursor instance", () => {
    expect(
      threadOffloadedToCursor(
        env({
          ...base,
          providerInstances: { claude: { driver: "claudeAgent", enabled: true, config: {} } },
        } as unknown as ServerSettings),
        t("a"),
      ),
    ).toBe(false);
  });

  // The server withholds offload while Cursor's overall window is full and spending is off.
  it("is false while Cursor credits are used up and spending is off", () => {
    const full = [cursorProvider(100)];
    expect(threadOffloadedToCursor(env(base, full), t("a"), NOW_MS)).toBe(false);
    expect(
      threadOffloadedToCursor(env({ ...base, allowSpendingCredits: true }, full), t("a"), NOW_MS),
    ).toBe(true);
    expect(threadOffloadedToCursor(env(base, [cursorProvider(99)]), t("a"), NOW_MS)).toBe(true);
    // A full window whose reset has passed no longer blocks.
    expect(
      threadOffloadedToCursor(
        env(base, [cursorProvider(100, "2026-10-09T11:59:00.000Z")]),
        t("a"),
        NOW_MS,
      ),
    ).toBe(true);
  });

  // The server refuses a Cursor instance whose config does not decode rather than guess a binary.
  it("is false when the Cursor instance's config cannot be read", () => {
    const unreadable = {
      ...base,
      providerInstances: { cursor: { ...cursorInstance, config: { binaryPath: 42 } } },
    } as unknown as ServerSettings;
    expect(threadOffloadedToCursor(env(unreadable), t("a"))).toBe(false);
  });

  // The server resolves the remembered instance, else the FIRST enabled one; it never skips a
  // broken first instance for a later one.
  it("counts only the first enabled Cursor instance when nothing is remembered", () => {
    const firstBroken = {
      ...base,
      providerInstances: {
        broken: { ...cursorInstance, config: { binaryPath: 42 } },
        cursor: cursorInstance,
      },
    } as unknown as ServerSettings;
    expect(threadOffloadedToCursor(env(firstBroken), t("a"))).toBe(false);
  });

  it("names why a thread set to Cursor does not offload", () => {
    expect(threadCursorOffload(env(base), t("a"), cursorOffloadReadiness(env(base)))).toBe("on");
    expect(threadCursorOffload(env(base), t("b"), cursorOffloadReadiness(env(base)))).toBe("off");
    const full = env(base, [cursorProvider(100)]);
    expect(threadCursorOffload(full, t("a"), cursorOffloadReadiness(full, NOW_MS))).toEqual({
      refused: 'Cursor has used 100% of its usage and "Allow to spend credits" is off.',
    });
    // A thread not set to Cursor has nothing to explain.
    expect(threadCursorOffload(full, t("b"), cursorOffloadReadiness(full, NOW_MS))).toBe("off");
    const unreadable = env({
      ...base,
      providerInstances: { cursor: { ...cursorInstance, config: { binaryPath: 42 } } },
    } as unknown as ServerSettings);
    expect(threadCursorOffload(unreadable, t("a"), cursorOffloadReadiness(unreadable))).toEqual({
      refused: 'Instance "cursor" has a Cursor config that could not be read.',
    });
  });

  it("counts offloaded threads that exist and are not archived", () => {
    const threads = new Map([
      [t("a"), { archivedAt: null }],
      [t("b"), { archivedAt: null }],
      [t("c"), { archivedAt: "2026-10-01T00:00:00Z" }],
    ]);
    expect(offloadedThreadCount(env(base), threads)).toBe(1);
    expect(offloadedThreadCount(env(base, [cursorProvider(100)]), threads, NOW_MS)).toBe(0);
    expect(offloadedThreadCount(null, threads)).toBe(0);
  });
});

describe("offloaded thread status", () => {
  const def = state({ instances: [instance("cursor_default")] });
  it("reports a partial dot with the thread count", () => {
    expect(subagentBackendRowStatus(def, undefined, true, 2)).toEqual({
      dot: "partial",
      text: "2 threads set to Cursor",
    });
    expect(subagentBackendRowStatus(def, undefined, true, 1)).toEqual({
      dot: "partial",
      text: "1 thread set to Cursor",
    });
  });
  it("falls back to Default when master is off or the count is 0", () => {
    expect(subagentBackendRowStatus(def, undefined, false, 2)).toEqual({
      dot: "off",
      text: "Default",
    });
    expect(subagentBackendRowStatus(def, undefined, true, 0)).toEqual({
      dot: "off",
      text: "Default",
    });
  });
  it("shows the thread count on a degraded Default file, since those threads still offload", () => {
    // A Default file is degraded after its remembered Cursor instance is disabled, while
    // threads set to Cursor keep offloading to another enabled instance.
    expect(
      subagentBackendRowStatus(
        state({ degraded: "bad" as never, instances: def.instances }),
        undefined,
        true,
        2,
      ),
    ).toEqual({ dot: "partial", text: "2 threads set to Cursor" });
  });
  it("keeps Degraded on a degraded Default file with no thread set to Cursor, or master off", () => {
    const degraded = state({ degraded: "bad" as never, instances: def.instances });
    expect(subagentBackendRowStatus(degraded, undefined, true, 0).text).toBe("Degraded");
    expect(subagentBackendRowStatus(degraded, undefined, false, 2).text).toBe("Degraded");
  });
  it("keeps degraded, unavailable and Cursor-backend precedence", () => {
    expect(
      subagentBackendRowStatus(
        state({
          backend: SUBAGENT_BACKEND_CURSOR,
          degraded: "bad" as never,
          instances: def.instances,
        }),
        undefined,
        true,
        2,
      ),
    ).toEqual({ dot: "off", text: "Degraded" });
    expect(subagentBackendRowStatus(state({}), undefined, true, 2).text).toBe("Cursor unavailable");
    expect(
      subagentBackendRowStatus({ ...def, backend: SUBAGENT_BACKEND_CURSOR }, undefined, true, 2)
        .dot,
    ).toBe("on");
  });
});

describe("subagentCursorTargetInstanceId", () => {
  it("prefers the stored instance, else the first, else null", () => {
    const withInstances = state({ instanceId: null, instances: [instance("cursor")] });
    expect(subagentCursorTargetInstanceId(withInstances)).toBe("cursor");
    expect(
      subagentCursorTargetInstanceId({
        ...withInstances,
        instanceId: instance("x").instanceId,
      }),
    ).toBe("x");
    expect(subagentCursorTargetInstanceId(null)).toBeNull();
  });
});

describe("subagentTargetSetInput", () => {
  const first = instance("cursor_default");
  const second = instance("cursor_personal");

  it("keeps the Default backend when a model is picked, targeting the first instance when none is stored", () => {
    expect(
      subagentTargetSetInput(
        state({ backend: SUBAGENT_BACKEND_DEFAULT, instances: [first, second] }),
        { model: "gpt-5" },
      ),
    ).toEqual({
      backend: SUBAGENT_BACKEND_DEFAULT,
      instanceId: first.instanceId,
      model: "gpt-5",
      targetOnly: true,
    });
  });

  it("keeps the Cursor backend when an instance is picked, carrying the stored model", () => {
    expect(
      subagentTargetSetInput(
        state({
          backend: SUBAGENT_BACKEND_CURSOR,
          instanceId: first.instanceId,
          model: "auto",
          instances: [first, second],
        }),
        { instanceId: ProviderInstanceId.make("cursor_personal") },
      ),
    ).toEqual({
      backend: SUBAGENT_BACKEND_CURSOR,
      instanceId: second.instanceId,
      model: "auto",
      targetOnly: true,
    });
  });

  it("omits keys that are null", () => {
    expect(subagentTargetSetInput(state({}), {})).toEqual({
      backend: SUBAGENT_BACKEND_DEFAULT,
      targetOnly: true,
    });
  });
});

describe("subagentTargetVisible", () => {
  const base = {
    isCursor: false,
    threadOnCursor: false,
    offloadedThreads: 0,
    cursorAvailable: true,
  };

  it("shows on Default when threads elsewhere are offloaded", () => {
    expect(subagentTargetVisible({ ...base, offloadedThreads: 2 })).toBe(true);
  });

  it("shows on Default when the open thread is on Cursor", () => {
    expect(subagentTargetVisible({ ...base, threadOnCursor: true })).toBe(true);
  });

  it("hides on Default with no thread on Cursor", () => {
    expect(subagentTargetVisible(base)).toBe(false);
  });

  it("hides without an enabled Cursor instance", () => {
    expect(
      subagentTargetVisible({
        ...base,
        threadOnCursor: true,
        offloadedThreads: 2,
        cursorAvailable: false,
      }),
    ).toBe(false);
  });

  it("shows when Cursor is the machine backend", () => {
    expect(subagentTargetVisible({ ...base, isCursor: true })).toBe(true);
  });
});

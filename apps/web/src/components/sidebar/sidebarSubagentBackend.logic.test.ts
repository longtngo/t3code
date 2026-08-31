import { describe, expect, it } from "vite-plus/test";
import {
  SUBAGENT_BACKEND_CURSOR,
  SUBAGENT_BACKEND_DEFAULT,
  type SubagentBackendInstance,
  type SubagentBackendState,
} from "@t3tools/contracts";

import {
  subagentBackendApplyInput,
  subagentBackendRowStatus,
  subagentCursorAvailable,
  subagentCursorInstancesPickable,
  subagentCursorModelOptions,
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

  it("switching to default drops instanceId and model", () => {
    expect(
      subagentBackendApplyInput(
        state({
          backend: SUBAGENT_BACKEND_CURSOR,
          instanceId: instance("cursor_default").instanceId,
          model: "auto",
        }),
        SUBAGENT_BACKEND_DEFAULT,
      ),
    ).toEqual({ backend: SUBAGENT_BACKEND_DEFAULT });
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

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { listCursorModels, peekCursorModels } from "./cursorModels.ts";
import { modelsForPersistedBackend, type PersistedBackend } from "./SubagentBackend.ts";

// vi.mock is hoisted above every import, so `modelsForPersistedBackend`'s calls to
// `listCursorModels`/`peekCursorModels` already resolve to these mocks. The `die`
// default on `listCursorModels` is the tripwire this file exists for: a `get`
// (refresh: false) that regresses into probing unconditionally kills the fiber
// instead of quietly passing.
vi.mock("./cursorModels.ts", () => ({
  listCursorModels: vi.fn(() =>
    Effect.die("listCursorModels should not run when refresh is false"),
  ),
  peekCursorModels: vi.fn(() => [{ id: "auto", label: "Auto" }]),
}));

afterEach(() => {
  vi.mocked(listCursorModels).mockReset();
  vi.mocked(listCursorModels).mockImplementation(() =>
    Effect.die("listCursorModels should not run when refresh is false"),
  );
  vi.mocked(peekCursorModels).mockReset();
  vi.mocked(peekCursorModels).mockImplementation(() => [{ id: "auto", label: "Auto" }]);
});

const CURSOR: PersistedBackend = {
  schemaVersion: 1,
  backend: "cursor",
  instanceId: "cursor",
  model: "auto",
  binaryPath: "/usr/local/bin/cursor-agent",
  apiEndpoint: "",
  updatedAt: null,
  degraded: null,
};

describe("modelsForPersistedBackend", () => {
  it.effect(
    "refresh: false (subagentBackend.get's default) reports the cache without probing",
    () =>
      Effect.gen(function* () {
        const models = yield* modelsForPersistedBackend(CURSOR, false);
        expect(models).toEqual([{ id: "auto", label: "Auto" }]);
        expect(peekCursorModels).toHaveBeenCalledWith(CURSOR.binaryPath);
        expect(listCursorModels).not.toHaveBeenCalled();
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refresh: true (set, or a panel-open get) probes", () =>
    Effect.gen(function* () {
      vi.mocked(listCursorModels).mockReturnValueOnce(
        Effect.succeed([{ id: "composer-2.5", label: "Composer 2.5" }]),
      );
      const models = yield* modelsForPersistedBackend(CURSOR, true);
      expect(models).toEqual([{ id: "composer-2.5", label: "Composer 2.5" }]);
      expect(listCursorModels).toHaveBeenCalledWith(CURSOR.binaryPath);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("probes nothing for a non-cursor or binary-less backend, regardless of refresh", () =>
    Effect.gen(function* () {
      const defaultBackend: PersistedBackend = { ...CURSOR, backend: "default", binaryPath: null };
      const models = yield* modelsForPersistedBackend(defaultBackend, true);
      expect(models).toEqual([]);
      expect(listCursorModels).not.toHaveBeenCalled();
      expect(peekCursorModels).not.toHaveBeenCalled();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

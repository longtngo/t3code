/**
 * Deterministic wire-size benchmark for the low-bandwidth roadmap (Phase 0).
 *
 * Encodes representative frames the way the client↔server socket carries them
 * today (JSON) and models the three scenarios from the design doc into a byte
 * budget. This is the *repeatable baseline* — every later phase re-runs it (and
 * re-runs the live meter) to quantify its delta. It is intentionally free of
 * runtime dependencies so it produces stable, CI-checkable numbers.
 *
 * The current wire is JSON, so the JSON column is the baseline. The JSON+deflate
 * column shows the headroom transport compression alone would recover; Phase 1
 * (MsgPack + deflate) adds a third column when `msgpackr` becomes a real dep.
 */

import * as zlib from "node:zlib";

/** host-metrics streams at 1.5s by default (ws.ts subscribeHostMetrics). */
export const HOST_METRICS_INTERVAL_SECONDS = 1.5;
/** llm-models streams at 4s by default (ws.ts subscribeLlmModels). */
export const LLM_MODELS_INTERVAL_SECONDS = 4;
/** Phase 1 only deflates frames above this size; smaller frames pay overhead for nothing. */
export const DEFLATE_THRESHOLD_BYTES = 1024;

export interface FrameSizes {
  readonly json: number;
  /** Wire size under Phase 1's threshold rule: deflate only above the threshold. */
  readonly jsonDeflated: number;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Raw-deflate size (no zlib header) — the closest analogue to per-message deflate. */
export function jsonDeflatedBytes(value: unknown): number {
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(value))).length;
}

export function measureFrame(value: unknown): FrameSizes {
  const json = jsonBytes(value);
  const jsonDeflated = json > DEFLATE_THRESHOLD_BYTES ? jsonDeflatedBytes(value) : json;
  return { json, jsonDeflated };
}

// ---------------------------------------------------------------------------
// Representative frames (plain objects mirroring the real contract shapes; byte
// size is identical to the schema-encoded payload, which is what we measure).
// ---------------------------------------------------------------------------

export const hostMetricsFrame = {
  ts: 1_720_000_000_000,
  cpu: { usage: 0.42, cores: 12, loadAvg1: 3.1 },
  mem: { totalBytes: 68_719_476_736, usedBytes: 41_231_686_144, freeBytes: 27_487_790_592 },
  gpu: { usage: 0.18, memoryUsedBytes: 5_368_709_120 },
  host: { platform: "darwin", release: "25.5.0", arch: "arm64", hostname: "dev-laptop" },
} as const;

export const llmModelsFrame = {
  ts: 1_720_000_000_000,
  ramBudgetBytes: 51_539_607_552,
  ramUsedBytes: 24_696_061_952,
  providers: [
    {
      id: "mlx-serve",
      label: "mlx-serve",
      reachable: true,
      models: [
        {
          id: "Ornith-1.0-35B",
          loaded: true,
          state: "ready",
          sizeBytes: 21_474_836_480,
          quantization: "4-bit",
          contextLength: 262_144,
          isMoe: true,
          status: "online",
          pid: 41_231,
          port: 8080,
          managed: true,
          engine: "mlx-serve",
        },
      ],
    },
    { id: "lmstudio", label: "LM Studio", reachable: false, models: [] },
  ],
} as const;

const toolActivity = (index: number) => ({
  id: `act_${index.toString().padStart(4, "0")}`,
  kind: "tool_use",
  role: "assistant",
  toolName: "Bash",
  input: { command: `rg --files-with-matches "pattern-${index}" packages/`, description: "search" },
  output: `packages/client-runtime/src/file-${index}.ts\npackages/contracts/src/file-${index}.ts`,
  status: "completed",
  createdAt: `2026-07-05T00:${(index % 60).toString().padStart(2, "0")}:00.000Z`,
});

/** One `thread.activity-appended` frame carrying a tool step. */
export const activityFrame = {
  sequence: 4242,
  eventId: "evt_0f8a1c2b3d4e5f60",
  aggregateKind: "thread",
  aggregateId: "thr_9a8b7c6d5e4f",
  occurredAt: "2026-07-05T00:12:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: { providerTurnId: "turn_1a2b", adapterKey: "claude" },
  type: "thread.activity-appended",
  payload: { threadId: "thr_9a8b7c6d5e4f", activity: toolActivity(42) },
} as const;

/** One `thread.activity-appended` frame carrying a long assistant message. */
export const assistantMessageFrame = {
  sequence: 4260,
  eventId: "evt_1a2b3c4d5e6f7081",
  aggregateKind: "thread",
  aggregateId: "thr_9a8b7c6d5e4f",
  occurredAt: "2026-07-05T00:12:30.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: { providerTurnId: "turn_1a2b", adapterKey: "claude" },
  type: "thread.activity-appended",
  payload: {
    threadId: "thr_9a8b7c6d5e4f",
    activity: {
      id: "act_message_0001",
      kind: "message",
      role: "assistant",
      text: "Here is a representative multi-paragraph assistant reply. ".repeat(40),
      createdAt: "2026-07-05T00:12:30.000Z",
    },
  },
} as const;

/** Full thread snapshot the server prepends on every (re)subscribe — the reconnect cost. */
export const threadSnapshotFrame = {
  kind: "snapshot",
  snapshot: {
    snapshotSequence: 4260,
    thread: {
      id: "thr_9a8b7c6d5e4f",
      projectId: "prj_1122334455",
      title: "Low-bandwidth support build-task",
      status: "active",
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:12:30.000Z",
      activities: Array.from({ length: 24 }, (_unused, index) => toolActivity(index)),
    },
  },
} as const;

/**
 * Attachment upload frame — a photo carried as base64 today. `dataBase64` is a
 * ~1MB base64 string standing in for a modestly-sized image (real uploads reach
 * the 20MB cap, ~27MB on the wire after base64's 33% inflation).
 */
export function attachmentUploadFrame(rawBytes = 768 * 1024): {
  threadId: string;
  fileName: string;
  dataBase64: string;
} {
  // Fill with a deterministic, poorly-compressible pattern so the deflate column
  // is honest: a real JPEG is already compressed and only recovers base64's
  // overhead under deflate — it does not shrink further. An all-identical fill
  // would falsely show ~100% compressibility.
  const buffer = Buffer.allocUnsafe(rawBytes);
  let state = 0x12345678;
  for (let index = 0; index < rawBytes; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buffer[index] = (state >>> 16) & 0xff;
  }
  const base64 = buffer.toString("base64");
  return { threadId: "thr_9a8b7c6d5e4f", fileName: "photo.jpg", dataBase64: base64 };
}

// ---------------------------------------------------------------------------
// Scenario budgets
// ---------------------------------------------------------------------------

/** Reconnecting N times re-downloads the full thread snapshot each time (today). */
export function reconnectBudgetBytes(reconnects: number, snapshotBytes: number): number {
  return reconnects * snapshotBytes;
}

/** A backgrounded phone still streams host-metrics + llm-models for the whole window. */
export function idleBackgroundedBudgetBytes(
  windowSeconds: number,
  hostFrameBytes: number,
  llmFrameBytes: number,
): number {
  const hostFrames = Math.floor(windowSeconds / HOST_METRICS_INTERVAL_SECONDS);
  const llmFrames = Math.floor(windowSeconds / LLM_MODELS_INTERVAL_SECONDS);
  return hostFrames * hostFrameBytes + llmFrames * llmFrameBytes;
}

/** One agentic turn: K tool steps (one frame each) plus the final assistant message. */
export function agenticTurnBudgetBytes(
  toolSteps: number,
  activityFrameBytes: number,
  messageFrameBytes: number,
): number {
  return toolSteps * activityFrameBytes + messageFrameBytes;
}

export interface FrameRow {
  readonly name: string;
  readonly sizes: FrameSizes;
}

export interface ScenarioRow {
  readonly name: string;
  readonly json: number;
  readonly jsonDeflated: number;
  readonly detail: string;
}

export interface BudgetReport {
  readonly frames: readonly FrameRow[];
  readonly scenarios: readonly ScenarioRow[];
}

export function computeBudgetReport(): BudgetReport {
  const host = measureFrame(hostMetricsFrame);
  const llm = measureFrame(llmModelsFrame);
  const activity = measureFrame(activityFrame);
  const message = measureFrame(assistantMessageFrame);
  const snapshot = measureFrame(threadSnapshotFrame);
  const attachment = measureFrame(attachmentUploadFrame());

  const frames: FrameRow[] = [
    { name: "host-metrics sample", sizes: host },
    { name: "llm-models sample", sizes: llm },
    { name: "activity-appended (tool step)", sizes: activity },
    { name: "activity-appended (assistant message)", sizes: message },
    { name: "thread snapshot (24 activities)", sizes: snapshot },
    { name: "attachment upload (~768KB photo)", sizes: attachment },
  ];

  const reconnects = 10;
  const idleSeconds = 600;
  const toolSteps = 12;

  const scenarios: ScenarioRow[] = [
    {
      name: `${reconnects}× reconnect on one thread`,
      json: reconnectBudgetBytes(reconnects, snapshot.json),
      jsonDeflated: reconnectBudgetBytes(reconnects, snapshot.jsonDeflated),
      detail: `${reconnects} × full snapshot`,
    },
    {
      name: `${idleSeconds / 60}-min backgrounded idle`,
      json: idleBackgroundedBudgetBytes(idleSeconds, host.json, llm.json),
      jsonDeflated: idleBackgroundedBudgetBytes(idleSeconds, host.jsonDeflated, llm.jsonDeflated),
      detail: `host@${HOST_METRICS_INTERVAL_SECONDS}s + llm@${LLM_MODELS_INTERVAL_SECONDS}s`,
    },
    {
      name: `agentic turn (${toolSteps} tool steps)`,
      json: agenticTurnBudgetBytes(toolSteps, activity.json, message.json),
      jsonDeflated: agenticTurnBudgetBytes(
        toolSteps,
        activity.jsonDeflated,
        message.jsonDeflated,
      ),
      detail: `${toolSteps} × activity + 1 message`,
    },
  ];

  return { frames, scenarios };
}

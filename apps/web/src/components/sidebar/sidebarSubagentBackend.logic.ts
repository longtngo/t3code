import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  SUBAGENT_BACKEND_CURSOR,
  SUBAGENT_BACKEND_DEFAULT,
  type ServerProvider,
  type ServerSettings,
  type SubagentBackendModelOption,
  type SubagentBackendSetInput,
  type ProviderInstanceId,
  type SubagentBackendState,
  type ThreadId,
  subagentBackendThreadMode,
} from "@t3tools/contracts";
import { CursorSettings } from "@t3tools/provider-cursor/settings";
import { cursorOffloadBlockedReason, cursorTotalUsageLimits } from "@t3tools/shared/usageLimits";

/** Dot tone for the collapsed row: green when Cursor is actually dispatching, "partial" when only
 *  some threads are set to Cursor, grey otherwise. */
export type SubagentBackendDotTone = "on" | "partial" | "off";

export interface SubagentBackendRowStatus {
  readonly dot: SubagentBackendDotTone;
  readonly text: string;
}

/**
 * What the collapsed sidebar row reads, in priority order:
 *
 * 1. No state yet (still loading the first `get`) — a neutral placeholder.
 * 2. `degraded` — the on-disk state couldn't be used as written; surfaced here (not just in
 *    the panel) so a broken toggle is visible without expanding it. Not on a Default backend
 *    with threads set to Cursor (step 5): a Default file is degraded when its remembered
 *    Cursor instance is disabled, yet those threads still offload to another enabled one, so
 *    the count wins and the panel carries the reason.
 * 3. No enabled Cursor instance — Cursor cannot be the active backend regardless of what the
 *    persisted `backend` field says, so the row says so directly.
 * 4. Cursor is the active backend — the selected model's label, falling back to its raw id
 *    (unrecognised by the cached model list) and then to "Auto" (no model chosen yet).
 * 5. Default backend, master on, and some live threads set to Cursor — a partial dot and the
 *    thread count.
 * 6. Anything else — including the "default" backend and any unrecognised value, which the
 *    wire contract says must read as default — is the default route.
 *
 * `masterEnabled: false` forces the dot grey without changing the text. This row is always
 * mounted, so it is the only part of the feature most users ever see, and under master-off
 * no T3 thread offloads — a green dot there would be a lie. The text stays because the
 * machine-wide file the row names is still live for non-T3 tools on this host.
 */
export function subagentBackendRowStatus(
  state: SubagentBackendState | null,
  options?: ReadonlyArray<SubagentBackendModelOption>,
  masterEnabled?: boolean,
  offloadedThreads = 0,
): SubagentBackendRowStatus {
  if (state == null) return { dot: "off", text: "Loading…" };
  const cursorBackend = state.backend === SUBAGENT_BACKEND_CURSOR;
  const partial = !cursorBackend && masterEnabled !== false && offloadedThreads > 0;
  if (state.degraded != null && !partial) return { dot: "off", text: "Degraded" };
  if (state.instances.length === 0) return { dot: "off", text: "Cursor unavailable" };
  if (cursorBackend) {
    const dot = masterEnabled === false ? "off" : "on";
    return { dot, text: subagentModelLabel(state, options ?? state.models) };
  }
  if (partial) {
    return {
      dot: "partial",
      text: `${offloadedThreads} thread${offloadedThreads === 1 ? "" : "s"} set to Cursor`,
    };
  }
  return { dot: "off", text: "Default" };
}

/** What one environment's server reports: its settings and its providers (a `ServerConfig`). */
interface OffloadSource {
  readonly settings: Pick<
    ServerSettings,
    | "subagentBackendEnabled"
    | "subagentBackendThreadModes"
    | "providerInstances"
    | "allowSpendingCredits"
  >;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "driver" | "enabled" | "usageLimits">>;
}

const decodeCursorSettings = Schema.decodeUnknownOption(CursorSettings);

/** Whether one environment's server can offload a thread set to Cursor: "unavailable" with the
 *  master switch off or no enabled Cursor instance, a refusal reason, or "ready". */
export type CursorOffloadReadiness = "unavailable" | "ready" | { readonly refused: string };

/**
 * The per-environment half of the server's `resolveThreadBackend` for a Default machine: Cursor
 * credits must not be used up with spending off (`cursorOffloadBlockedReason`), and the first
 * enabled Cursor instance must have a config that decodes (`validateCursorInstance`). One known
 * gap: the server tries the remembered instance before the first one, and these settings do not
 * carry it.
 */
export function cursorOffloadReadiness(
  source: OffloadSource | null | undefined,
  nowMs = Date.now(),
): CursorOffloadReadiness {
  const settings = source?.settings;
  if (settings == null || settings.subagentBackendEnabled === false) return "unavailable";
  const first = Object.entries(settings.providerInstances).find(
    ([, entry]) => entry.driver === SUBAGENT_BACKEND_CURSOR && entry.enabled === true,
  );
  if (first === undefined) return "unavailable";
  const creditsBlocked = cursorOffloadBlockedReason({
    allowSpendingCredits: settings.allowSpendingCredits,
    cursorLimits: cursorTotalUsageLimits(source?.providers ?? []),
    nowMs,
  });
  if (creditsBlocked !== null) return { refused: creditsBlocked };
  const [instanceId, instance] = first;
  if (Option.isNone(decodeCursorSettings(instance.config ?? {}))) {
    return { refused: `Instance "${instanceId}" has a Cursor config that could not be read.` };
  }
  return "ready";
}

/** Whether a thread set to Cursor offloads ("on"), why it does not, or "off" when it is not set
 *  to Cursor or its server cannot offload at all. A Cursor machine backend is not counted here;
 *  the footer's green icon covers it. */
export function threadCursorOffload(
  source: OffloadSource | null | undefined,
  threadId: ThreadId,
  readiness: CursorOffloadReadiness,
): "off" | "on" | { readonly refused: string } {
  if (source == null || readiness === "unavailable") return "off";
  if (subagentBackendThreadMode(source.settings.subagentBackendThreadModes, threadId) !== "on") {
    return "off";
  }
  return readiness === "ready" ? "on" : readiness;
}

/** Whether this thread's own server offloads its subagents to Cursor because the thread is set to
 *  Cursor; see `threadCursorOffload`. */
export function threadOffloadedToCursor(
  source: OffloadSource | null | undefined,
  threadId: ThreadId,
  nowMs = Date.now(),
): boolean {
  return threadCursorOffload(source, threadId, cursorOffloadReadiness(source, nowMs)) === "on";
}

/** Live threads set to Cursor. The modes map is never pruned when a thread is deleted, so ids are
 *  checked against the environment's threads; archived threads do not run and are not counted. */
export function offloadedThreadCount(
  source: OffloadSource | null | undefined,
  threads: ReadonlyMap<ThreadId, { readonly archivedAt: unknown }>,
  nowMs = Date.now(),
): number {
  if (source == null) return 0;
  const readiness = cursorOffloadReadiness(source, nowMs);
  return (Object.keys(source.settings.subagentBackendThreadModes) as ThreadId[]).filter(
    (id) =>
      threads.get(id)?.archivedAt === null && threadCursorOffload(source, id, readiness) === "on",
  ).length;
}

function subagentModelLabel(
  state: SubagentBackendState,
  options: ReadonlyArray<SubagentBackendModelOption>,
): string {
  if (state.model == null) return "Auto";
  return options.find((model) => model.id === state.model)?.label ?? state.model;
}

/** Whether an enabled Cursor instance exists at all — gates the Cursor side of the segmented
 *  control and the "Cursor unavailable" copy. */
export function subagentCursorAvailable(state: SubagentBackendState | null): boolean {
  return (state?.instances.length ?? 0) > 0;
}

/** Whether the panel shows the Cursor model picker: always on Cursor, and on Default whenever
 *  some thread (the open one or any other) is set to Cursor and an instance exists. */
export function subagentTargetVisible(input: {
  readonly isCursor: boolean;
  readonly threadOnCursor: boolean;
  readonly offloadedThreads: number;
  readonly cursorAvailable: boolean;
}): boolean {
  return (
    input.isCursor ||
    ((input.threadOnCursor || input.offloadedThreads > 0) && input.cursorAvailable)
  );
}

/** The provider (instance) select only earns its place in the panel when there is an actual
 *  choice to make — one instance needs no picker. */
export function subagentCursorInstancesPickable(state: SubagentBackendState | null): boolean {
  return (state?.instances.length ?? 0) > 1;
}

/**
 * Notes under the per-thread control. The segment itself renders only while the thread's own
 * server has the master on; its absence is explained only when that server disagrees with the
 * primary (when both are off, the panel's own master-off line has already said it).
 * `cursorAvailable` is `null` when unknown — a thread on another environment (the primary's
 * instance list says nothing about that server) or state not yet loaded — so no Cursor note
 * is offered on a guess. `refused` leads, since it explains why a thread set to Cursor is not
 * offloading.
 */
export function threadOffloadNotes(input: {
  readonly threadMasterEnabled: boolean;
  readonly primaryMasterEnabled: boolean;
  readonly cursorAvailable: boolean | null;
  /** Why the server will not offload this thread although it is set to Cursor. */
  readonly refused?: string | null;
}): ReadonlyArray<string> {
  if (!input.threadMasterEnabled) {
    return input.primaryMasterEnabled
      ? ["Subagent offload is switched off on this thread's server."]
      : [];
  }
  return [
    ...(input.refused ? [input.refused] : []),
    ...(input.cursorAvailable === false
      ? ["Add a Cursor instance in Settings to use Cursor here."]
      : []),
    "Applies to Claude Code threads.",
  ];
}

/** The Cursor instance the model picker lists: the stored one, else the first enabled one (a
 *  Default state from before any pick names none, and one instance shows no instance picker). */
export function subagentCursorTargetInstanceId(state: SubagentBackendState | null) {
  return state?.instanceId ?? state?.instances[0]?.instanceId ?? null;
}

function subagentSetInput(
  state: SubagentBackendState,
  backend: string,
  pick: { readonly instanceId?: ProviderInstanceId; readonly model?: string },
): SubagentBackendSetInput {
  const instanceId = pick.instanceId ?? subagentCursorTargetInstanceId(state);
  const model = pick.model ?? state.model;
  return {
    backend:
      backend === SUBAGENT_BACKEND_CURSOR ? SUBAGENT_BACKEND_CURSOR : SUBAGENT_BACKEND_DEFAULT,
    ...(instanceId ? { instanceId } : {}),
    ...(model ? { model } : {}),
  };
}

/** The `set` payload for the instance and model pickers: only the picked target changes (see
 *  `SubagentBackendSetInput.targetOnly`). */
export function subagentTargetSetInput(
  state: SubagentBackendState,
  pick: { readonly instanceId?: ProviderInstanceId; readonly model?: string },
): SubagentBackendSetInput {
  return { ...subagentSetInput(state, state.backend, pick), targetOnly: true };
}

/**
 * Builds the `set` payload for the segmented toggle. Both backends remember the target
 * (`instanceId`/`model`), falling back to the first available instance when none is stored:
 * a fresh state has none, and a Cursor request without one is rejected, so the toggle could
 * never be turned on. Switching to Default stores that first instance too; dispatch is
 * unchanged because readers fall back to the same instance.
 */
export function subagentBackendApplyInput(
  state: SubagentBackendState,
  backend: string,
): SubagentBackendSetInput {
  return subagentSetInput(state, backend, {});
}

/**
 * The Cursor provider and the `cursor-agent` CLI name Auto differently — `auto-smart` over ACP,
 * `auto` on the command line. Both are accepted by `--model`, but only `auto` is one the CLI
 * advertises, so the picker offers the provider's label against the CLI's id.
 */
const CURSOR_AUTO_PROVIDER_SLUG = "auto-smart";
const CURSOR_AUTO_CLI_ID = "auto";

/** One visible model from the Cursor provider, as `getAppModelOptionsForInstance` reports it. */
export interface SubagentCursorVisibleModel {
  readonly slug: string;
  readonly name: string;
}

/**
 * The model picker's options: the Cursor provider's own model list, honouring whatever the user
 * hid or reordered for that instance, rather than the ~200 concrete ids `cursor-agent
 * --list-models` advertises. The two are separate namespaces that overlap in only nine ids, and
 * the CLI accepts provider slugs it never advertises, so the provider list is both the shorter
 * list and the one the user actually curated.
 *
 * `visibleModels: null` means the provider snapshot has not arrived yet — distinct from an empty
 * list, which means the user hid everything. Only the former falls back to the CLI list, since a
 * picker that silently repopulates itself with 200 entries would misreport the second case as the
 * first.
 *
 * A selected model missing from the list is appended rather than dropped, so a stored value the
 * provider no longer offers still renders as the current selection instead of a blank control.
 */
export function subagentCursorModelOptions(
  state: SubagentBackendState | null,
  visibleModels: ReadonlyArray<SubagentCursorVisibleModel> | null,
): ReadonlyArray<SubagentBackendModelOption> {
  if (state == null) return [];
  if (visibleModels == null) return state.models;

  const options: SubagentBackendModelOption[] = visibleModels.map((model) => ({
    id: model.slug === CURSOR_AUTO_PROVIDER_SLUG ? CURSOR_AUTO_CLI_ID : model.slug,
    label: model.name,
  }));

  const selected = state.model;
  if (selected != null && !options.some((option) => option.id === selected)) {
    options.push({
      id: selected,
      label: state.models.find((model) => model.id === selected)?.label ?? selected,
    });
  }
  return options;
}

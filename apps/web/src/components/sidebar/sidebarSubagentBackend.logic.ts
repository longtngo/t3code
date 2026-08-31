import {
  SUBAGENT_BACKEND_CURSOR,
  SUBAGENT_BACKEND_DEFAULT,
  type SubagentBackendModelOption,
  type SubagentBackendSetInput,
  type SubagentBackendState,
} from "@t3tools/contracts";

/** Dot tone for the collapsed row: green when Cursor is actually dispatching, grey otherwise. */
export type SubagentBackendDotTone = "on" | "off";

export interface SubagentBackendRowStatus {
  readonly dot: SubagentBackendDotTone;
  readonly text: string;
}

/**
 * What the collapsed sidebar row reads, in priority order:
 *
 * 1. No state yet (still loading the first `get`) — a neutral placeholder.
 * 2. `degraded` — the on-disk state couldn't be used as written; surfaced here (not just in
 *    the panel) so a broken toggle is visible without expanding it.
 * 3. No enabled Cursor instance — Cursor cannot be the active backend regardless of what the
 *    persisted `backend` field says, so the row says so directly.
 * 4. Cursor is the active backend — the selected model's label, falling back to its raw id
 *    (unrecognised by the cached model list) and then to "Auto" (no model chosen yet).
 * 5. Anything else — including the "default" backend and any unrecognised value, which the
 *    wire contract says must read as default — is the default route.
 */
export function subagentBackendRowStatus(
  state: SubagentBackendState | null,
  options?: ReadonlyArray<SubagentBackendModelOption>,
): SubagentBackendRowStatus {
  if (state == null) return { dot: "off", text: "Loading…" };
  if (state.degraded != null) return { dot: "off", text: "Degraded" };
  if (state.instances.length === 0) return { dot: "off", text: "Cursor unavailable" };
  if (state.backend === SUBAGENT_BACKEND_CURSOR) {
    return { dot: "on", text: subagentModelLabel(state, options ?? state.models) };
  }
  return { dot: "off", text: "Default" };
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

/** The provider (instance) select only earns its place in the panel when there is an actual
 *  choice to make — one instance needs no picker. */
export function subagentCursorInstancesPickable(state: SubagentBackendState | null): boolean {
  return (state?.instances.length ?? 0) > 1;
}

/**
 * Builds the `set` payload for the segmented toggle. Off never has a persisted
 * `instanceId` (see `OFF` in `SubagentBackend.ts`), so switching to Cursor from a
 * fresh/off state must fall back to the first available instance — otherwise the
 * request omits `instanceId` entirely, the server rejects it, and the toggle can
 * never be turned on.
 */
export function subagentBackendApplyInput(
  state: SubagentBackendState,
  backend: string,
): SubagentBackendSetInput {
  if (backend !== SUBAGENT_BACKEND_CURSOR) return { backend: SUBAGENT_BACKEND_DEFAULT };
  const instanceId = state.instanceId ?? state.instances[0]?.instanceId;
  return {
    backend: SUBAGENT_BACKEND_CURSOR,
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(state.model ? { model: state.model } : {}),
  };
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

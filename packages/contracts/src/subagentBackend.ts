/**
 * Contracts for the subagent dispatch toggle.
 *
 * The state lives in a JSON file outside T3 home that a shell wrapper reads at
 * dispatch time; these types are the wire shape of that state, not the file
 * format itself. `backend` is a plain string rather than a literal union so a
 * file written by a newer build degrades to "default" instead of failing the
 * whole decode.
 *
 * @module subagentBackend
 */
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/** Dispatch through Cursor. Any other value, including an unknown one, means the default route. */
export const SUBAGENT_BACKEND_CURSOR = "cursor";
/** No Cursor dispatch: subagents run on whatever model the session already uses. */
export const SUBAGENT_BACKEND_DEFAULT = "default";

export const SubagentBackendModelOption = Schema.Struct({
  /** A cursor-agent CLI id, e.g. "auto" or "composer-2.5". Not an ACP base slug. */
  id: Schema.String,
  /** Human label from the CLI listing, e.g. "Composer 2.5". */
  label: Schema.String,
});
export type SubagentBackendModelOption = typeof SubagentBackendModelOption.Type;

export const SubagentBackendInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.String,
  accentColor: Schema.optional(Schema.String),
});
export type SubagentBackendInstance = typeof SubagentBackendInstance.Type;

export const SubagentBackendState = Schema.Struct({
  /** "cursor" or "default"; an unrecognised value is reported verbatim and treated as default. */
  backend: Schema.String,
  instanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(Schema.String),
  /** Cursor instances available to pick. Empty when none is enabled. */
  instances: Schema.Array(SubagentBackendInstance),
  /** CLI model ids for the selected instance; empty until the probe has run. */
  models: Schema.Array(SubagentBackendModelOption),
  /**
   * Set when the state on disk could not be used as written: a corrupt file, or a
   * binary the server could not resolve. Distinguishes "off" from "broken" so the
   * panel can warn instead of silently reading as Default forever.
   */
  degraded: Schema.NullOr(Schema.String),
  /**
   * Set only on a `set` response that changed nothing: why it was refused. The rest of the
   * state is what is stored, so a refusal never reads as a degraded backend. Absent from
   * servers that predate it, which report refusals through `degraded`.
   */
  refused: Schema.optional(Schema.String),
});
export type SubagentBackendState = typeof SubagentBackendState.Type;

export const SubagentBackendSetInput = Schema.Struct({
  backend: Schema.String,
  instanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(Schema.String),
  /**
   * Only the Cursor target (`instanceId`/`model`) changes; the server keeps the backend already
   * on disk and ignores `backend`. Sent by the instance and model pickers, whose view of the
   * backend can be stale. `backend` is still required so servers that predate this field (which
   * ignore it) keep their old behaviour.
   */
  targetOnly: Schema.optional(Schema.Boolean),
});
export type SubagentBackendSetInput = typeof SubagentBackendSetInput.Type;

/** One usage window as Cursor reports it, already normalized by the server. */
export const CursorUsageSnapshot = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String,
  startsAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CursorUsageSnapshot = typeof CursorUsageSnapshot.Type;

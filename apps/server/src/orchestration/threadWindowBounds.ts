/**
 * Shared thread-load window bounds (ITEM 2 — giant-frame OOM defense).
 *
 * Opening a long thread without a window decodes and serializes the ENTIRE thread
 * (every message/activity/plan/checkpoint blob) into a single wire frame — the
 * "99MB single frame" that, once msgpack-packed + deflated + framed, transiently
 * allocates hundreds of MB to >1GB of external buffers and OOMs the server. The
 * windowing machinery already exists in
 * {@link ProjectionSnapshotQuery.getThreadDetailById}; these constants make the
 * bounded path the default for BOTH snapshot loaders (the live `subscribeThread`
 * WS snapshot and the HTTP thread-snapshot). Older history stays reachable via the
 * `getThreadHistoryPage` RPC. Shared so both loaders enforce the identical budget.
 */

/**
 * Default window applied when the client sends no explicit bounds. `windowTurns: 0`
 * is a schema-valid NonNegativeInt that resolves to a null window boundary (whole
 * thread) downstream, so a non-positive bound is treated as "unset" at the call site.
 */
export const DEFAULT_SUBSCRIBE_WINDOW_TURNS = 15;
export const DEFAULT_SUBSCRIBE_WINDOW_MAX_ROWS = 2_000;

/**
 * Server-internal serialized-byte budget: the third window bound alongside
 * turns/rows, capping frame size for the "few turns, heavy payloads" thread that
 * slips under the turn/row caps yet still ships megabytes. Not client-tunable; the
 * query keeps at least one turn so paging always advances.
 */
export const WINDOW_MAX_BYTES = 4 * 1024 * 1024;

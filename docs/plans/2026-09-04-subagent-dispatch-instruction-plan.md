# Plan — subagent dispatch instruction + toggle latency

Design: `docs/design/2026-09-04-subagent-dispatch-instruction-design.md`. Branch
`fix/subagent-dispatch-instruction`. Every task is a commit.

## Task 1 — the instruction and its pure selector

`apps/server/src/provider/Layers/ClaudeAdapter.ts`

Add, beside the `queryOptions` build (not in `RuntimeInstructions.ts` — four other adapters
import that):

- `SUBAGENT_DISPATCH_INSTRUCTION`, the exact text from the design's Approach section.
- `subagentDispatchAppend(backend: string): string` — returns the instruction when
  `backend === SUBAGENT_BACKEND_CURSOR`, `""` otherwise. Exported for test 1/2.

**Test** (`ClaudeAdapter.test.ts` or a sibling): the selector returns a string containing
`subagent-dispatch` for `"cursor"`, and `""` for `"default"`, for an unknown value, and for the
`OFF` record's backend. Assert with `toContain`, never full prose equality.

Commit: `feat(server): add the subagent dispatch instruction selector`

## Task 2 — read the thread's backend and append

`apps/server/src/provider/Layers/ClaudeAdapter.ts`

Inside `startSession`, before `queryOptions`, read the per-thread flag file with the existing
`readThreadBackendFile(serverConfig.subagentThreadsDir, input.threadId)` — `FileSystem` and
`serverConfig` are already bound at `:2083-2085`. `ProviderService` writes that file immediately
before both `adapter.startSession` call sites (`:620-622`, `:885-887`), so it is present; a
missing or malformed file reads as `default` and appends nothing, which is the fail-safe
direction.

Append the selector's result to `systemPrompt.append` after `buildRuntimeInstructions(...)`.

Annotate the existing session-start span (`:5077-5101`, alongside the `claude.query.*` keys) with
`claude.query.subagent_offload_injected`. Set it on **every** session start, `false` included.

**Test:** with a fixture threads dir containing a `cursor` file, `systemPrompt.append` contains
`subagent-dispatch`; with a `default` file and with no file at all, it does not. Extend the
existing `append`-pinning test at `ClaudeAdapter.test.ts:442-447` rather than adding a parallel
harness.

Commit: `fix(server): tell Claude sessions to dispatch subagents through the wrapper`

## Task 3 — take the model probe off `set`

`apps/server/src/ws.ts:2303-2305` — pass `false` as `refresh` to `modelsForPersistedBackend`,
matching `subagentBackendGet` on mount.

Fix the two comments the change makes false:

- `apps/server/src/subagentBackend/SubagentBackend.set.test.ts:31-33` — "ws always calls with true"
- `apps/server/src/subagentBackend/SubagentBackend.ts:607-611` — `refresh: true` (`set`, ...)

**Test:** at the `ws.ts` handler layer, `subagentBackend.set` resolves without spawning
`--list-models`. Not at `modelsForPersistedBackend` — that tests the callee, not the caller, which
is where the regression would be.

Commit: `perf(server): stop blocking the subagent toggle on the Cursor model probe`

## Task 4 — gate

1. `pnpm run fmt` over every file authored, markdown included.
2. Commit.
3. `pnpm verify`, machine otherwise idle. Read the actual output — the task notification reports
   exit 0 even when the gate is red, twice observed in this run.
4. Re-run the routing harness only if the instruction text changed again since A1b.

## Out of scope

The stale per-thread file fan-out gap. Real, self-healing, and not what was hit — it is in the
design's follow-ups.

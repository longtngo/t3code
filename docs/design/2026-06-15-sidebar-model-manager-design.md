# Sidebar Local-Model Manager — design (2026-06-15, rev. after review)

Reworks the just-merged read-only "LLM" toolbar indicator into a **sidebar local-model
manager**: relocate it above "Settings" in the left sidebar, and make each model row
actionable — click an **online** model to unload it (confirmation dialog), click an
**offline** model to load it and bring it online.

## Goal

1. **Relocate** the LLM indicator from the toolbar to the sidebar footer, above
   Settings, as an **inline collapsible section** (not a hover popover).
2. **Control mlx-serve**: load (spawn) / unload (kill) models from the sidebar.

## Why this is a process manager (key constraint)

mlx-serve has **no runtime load/unload API** (verified: `/load`, `/unload`,
`/v1/models/load`, `/admin` → 404; `--model` is fixed at launch; one model per
process). So: **load = spawn** `mlx-serve --model <dir> --serve --host 127.0.0.1
--port <p> [args]`; **unload = kill** that process; **available (offline) models** =
subdirectories of the models dir (default `~/llm/models`); **online models** =
running mlx-serve processes discovered via `ps`.

## Locked decisions (with user)

- **Concurrency:** multiple models online, gated by a **configurable RAM budget**.
- **Launch config:** **hybrid** — auto-scan models dir + global default args + optional
  per-model arg overrides.
- **External processes:** **manage all** mlx-serve — externally-started processes show
  online and can be unloaded (killed by pid, with safety checks).

## Scope (narrowed after review — see "Cuts")

**mlx-serve only.** v1 drops the generic `llmProviders` read-only probe and its
`dedupeProviders` path entirely (delete the dead code + its test). The single managed
mlx-serve group _is_ the list. Generic read-only providers move to follow-ups.

## Architecture

### Model identity & correlation

A model's id = its directory basename. **Correlate running processes to disk models by
the `--model` PATH parsed from the `ps` command line, NOT by the `/v1/models` id** (the
reported id can differ — `--served-model-name`, HF repo ids, external processes).
`realpath` both sides; key the union map on resolved `modelPath`. This prevents the
same physical model appearing as both an offline disk row and an online process row.

### Server: `LlmServeManager` service (`apps/server/src/llm/LlmServeManager.ts`, new)

Long-lived `Context.Service` (mirrors `cloud/ManagedEndpointRuntime.ts`) with a
`Ref<Map<number /*pid*/, ManagedLaunch>>` registry and a **`Semaphore.make(1)`**
guarding load admission. `ManagedLaunch = { child, scope, modelId, modelPath, port,
pgid, estBytes, startedAt, state: "loading" | "ready" | "stopping" | "exited" }`.
Provided in `RuntimeDependenciesLive` (`server.ts`). A **layer finalizer
(`Effect.addFinalizer`) unloads all managed launches on server shutdown**.

**`list()`** — total (never throws; `Effect.catchCause`-degrade) and opens **no
scopes**, so the sampler's `never` error channel is preserved:

1. `readProcessRows()` (lower-level export, lists ALL processes) → filter to **strict
   mlx-serve**: resolved executable basename `mlx-serve` AND `--serve` present AND a
   `--model` under the models dir; parse `--model <path>`, `--port`, capture `pid`,
   `pgid`, `rssBytes`, `etime`.
2. `readdir(modelsDir)` → available model dirs.
3. For each running process, reuse **`probeProvider({baseUrl: http://127.0.0.1:port})`**
   for `/v1/models` metadata (timeout-bounded, never-fails).
4. Merge keyed by resolved `modelPath`: union of disk dirs (offline) and running
   processes (online). Per-model `status`: a `ps` row whose pid is a **registry
   `stopping`** entry → `stopping`; a registry `loading` pid not yet healthy →
   `loading`; a registry pid whose child `exited` before ready → `error`; otherwise a
   `ps` row → `online`; a disk dir with no process → `offline`. `managed` = pid ∈
   registry. `sizeBytes` = RSS (online) / estimated dir size (offline). Also returns
   `ramBudgetBytes` and `ramUsedBytes` (Σ online RSS).

**`load(modelId)`** — runs **entirely under the load semaphore** (atomic
check-then-spawn-then-register, closing the TOCTOU on both port and budget):

1. **Validate `modelId` (security-critical):** must match `^[A-Za-z0-9._-]+$` (reject
   `/ \ .. NUL`, leading `-`), AND be an exact entry in the live `readdir(modelsDir)`
   allowlist. `modelPath = realpath(join(modelsDir, modelId))`; assert it is a direct
   child of `realpath(modelsDir)` (defeats symlink escape). Else `not_found`.
2. Reject if the model is already **online or loading** (dedupe by modelId) →
   `already_online`.
3. Estimate RAM = sum of file sizes in the model dir (flat, capped entry count — no
   unbounded recursion). Enforce budget: `Σ(online RSS) + Σ(in-flight loading
estimates) + estimate ≤ budget` (budget default = `os.totalmem() * 0.8` when unset)
   → else `budget_exceeded`.
4. Assign a free port from the fixed range **8765–8799**, skipping ports used by **any**
   process seen in `ps` and any registry entry → else `no_free_port`.
5. Build args: `["--serve", ...defaultArgs, ...(perModel[modelId]?.args ?? []),
"--host", "127.0.0.1", "--port", String(port), "--model", modelPath]` — `--model`
   and its value pushed as an **atomic pair**, value never whitespace-split.
6. Spawn into a **service-owned `Scope.make()`** (`Effect.provideService(Scope.Scope,
…)`), so it outlives the RPC. The spawner detaches the child into its own process
   group by default on non-Windows (so the scope's release reaps the group); set
   `detached: true` explicitly for clarity. Register as `loading`; fork a supervisor on
   `child.exitCode` that marks `exited`/removes the entry. Returns `{ pid, port }`.
   Spawn failure → `spawn_failed`.

**`unload(pid)`**:

- **Managed pid** → `Scope.close(launch.scope)`. The Effect spawner's release path
  **already reaps the whole detached process group** (it calls `killProcessGroup` =
  `process.kill(-pid, …)` with a bounded SIGTERM→SIGKILL escalation; children spawned
  via the spawner are detached/own-group by default on non-Windows). So `Scope.close`
  alone terminates mlx-serve + any llama.cpp/GGUF child — **no separate manual `-pgid`
  kill** (that would be a redundant competing path). Mark the registry entry `stopping`
  (do **not** delete on the call); the supervisor removes it when the child exits /
  disappears from `ps`, so it never flickers back to "external/online". (`pgid` is
  therefore not needed in `ManagedLaunch` for the kill — keep it only if useful for
  display.)
- **External pid** → must be present in the **most recent `list()` snapshot** as a
  strict-mlx row; **re-read and re-verify the pid immediately before killing**
  (command still strict-mlx AND same `--model`/`--port` AND matching `etime`/start —
  detects pid reuse); refuse `pid === process.pid` and any non-mlx process. Then
  `process.kill(pid, "SIGTERM")` → escalate (single pid only — never kill an external
  process _group_, which could include the user's shell). Best-effort; documented.
  Unknown/stale/mismatched pid → `not_mlx_process`.

### Contract (`packages/contracts/src/rpc.ts`, extend the merged schemas — additive)

- `LlmModel`: add `status: Schema.optional(Schema.Literal("online","offline","loading","stopping","error"))`,
  `pid?`, `port?`, `managed?: boolean`, `modelId?`, `loadError?`. Keep `loaded`
  required (back-compat); `mapModel` sets both `loaded` and `status`. Client derives
  display from `status ?? (loaded ? "online" : "offline")`.
- `LlmModelsSample`: add `ramBudgetBytes?`, `ramUsedBytes?`. **Keep the existing
  `providers: Array(LlmProvider)` shape** — `manager.list()` returns a single synthetic
  `LlmProvider{ name: "mlx-serve", models: [...] }`, so the sample carries exactly one
  group. This reuses the existing `LlmProvider` schema and the web `ProviderGroup`
  component / `lib/llmModels.ts` consumers with minimal churn (no new flat `models[]`).
- New unary RPCs (no `stream`) in `packages/contracts/src/llmServe.ts`:
  - `WsLlmServeLoadRpc` — payload `{ modelId }`, success `{ pid, port }`, error
    `Schema.Union([LlmServeError, EnvironmentAuthorizationError])`.
  - `WsLlmServeUnloadRpc` — payload `{ pid }`, success `{ ok: true }`, same error.
  - `LlmServeError` (tagged): `budget_exceeded | already_online | no_free_port |
not_found | spawn_failed | not_mlx_process`, each with a message.

### Server wiring (`apps/server/src/ws.ts`)

`yield* LlmServeManager` in the handler gen; 2 unary handlers via `observeRpcEffect`;
**2 `RPC_REQUIRED_SCOPE` rows with `AuthOrchestrationOperateScope`** (mutating + spawns
processes — read-only `subscribeLlmModels` stays `ReadScope`). Every method MUST have a
scope row or dispatch throws (fails closed). The `subscribeLlmModels` sampler now calls
`manager.list()`; its stream `R` gains `LlmServeManager` (+transitively
`ChildProcessSpawner`), satisfied ambiently — `list()` stays total so `E` stays `never`.

### Client wiring

`wsRpcClient.ts` (interface+impl, `RpcUnaryMethod`), `environmentApi.ts`, `ipc.ts`
(`EnvironmentApi.llmModels.load/unload`). New `useLlmModelActions` hook wrapping the
two RPCs with per-row pending state + an error toast.

### Settings (`packages/contracts/src/settings.ts`) — leaner

Replace `llmProviders` with:

```
localModels: {
  modelsDir: string                    // default "~/llm/models" (server expands ~)
  ramBudgetBytes: number               // default 0 -> os.totalmem()*0.8 at runtime
  defaultArgs: readonly string[]       // default ["--reasoning-budget","0","--no-pld"]
  perModel: Record<string, { args?: readonly string[] }>
}
```

All `withDecodingDefault`; updated via the existing `server.updateSettings` RPC. `host`
is hardcoded `127.0.0.1` (loopback — no setting, no `0.0.0.0` footgun); the port range
is a fixed constant (bounds concurrent processes at ~35). `llmProviders` is removed.

### UI — inline collapsible sidebar section

- **Relocate:** remove `<LlmModels>` + its hooks from `BranchToolbar.tsx`. In
  `SidebarChromeFooter` (`Sidebar.tsx:2543`), above the Settings `SidebarMenu`, render
  a collapsible section: a `SidebarMenuItem` header (dot + "Local models" + online
  count + RAM headroom) toggling an in-flow list (the sidebar's own collapsible idiom —
  not a popover). **Subscribe to the stream only while expanded** (collapsed = no
  subscription); this replaces the toolbar's manual pause toggle.
- **Actionable rows** (`LlmModels.tsx` rework into a sidebar list):
  - `offline` → click loads (`load(modelId)`); row → `loading` spinner; no confirm
    (loading is additive). Disabled (greyed + title) if it would exceed the budget.
  - `online` → click opens a **confirmation Dialog** ("Unload <model>? Stops the
    mlx-serve process (pid N) and frees ~<RAM>.") → `unload(pid)`. Reuses the app's
    `Dialog`/`DialogFooter` (`confirmThreadDelete` pattern).
  - `loading`/`stopping` → spinner, not clickable. `error` → shows `loadError` + retry.
  - Row: status dot (green online / amber loading / gray offline / red error), id,
    meta chips (quant/MoE/ctx when online), size, `managed`/`external` tag.

## Cuts (applied from review)

- **mlx-serve only**: dropped the generic `llmProviders` probe, `LlmProvider.managed`,
  and the `dedupeProviders` host:port dedupe (delete the function + only its `it(...)`
  block in `LlmModels.test.ts` — keep the `parseModelsResponse` tests, since
  `parseModelsResponse`/`probeProvider` are still used to read online models'
  `/v1/models`). Also remove the now-dead `SamplerState.lastProviders` fallback
  machinery in `llmModelsStream` (the sampler now reads `localModels` + calls
  `manager.list()`).
- **Leaner settings**: dropped configurable `host` (hardcoded loopback) and `portRange`
  (fixed constant); `perModel` trimmed to `{ args? }` (dropped `port`, `disabled`).
- **Budget**: keep real-RSS accounting + a _cheap_ flat-dir-size estimate (advisory);
  dropped any deep weight-file estimator subsystem.
- **Sidebar**: inline collapsible section, not a hover `side="right"` popover (which is
  non-idiomatic here and hostile to actionable rows); dropped the manual pause toggle.

## Alternatives considered

- Native provider load/unload (Ollama keep_alive) — N/A (mlx-serve has no API).
- Single active model (load swaps) — user chose RAM-budgeted multi.
- Detached-and-independent (`unref` to survive t3code) — rejected as contradictory:
  `unref` only frees the libuv handle, not the OS group. Decision: managed children run
  in their **own process group** (`detached:true`) so unload can reap the whole group
  by `-pgid`; a **layer finalizer** unloads them on t3code shutdown (so they stop with
  t3code, per the locked model). External processes are untouched on shutdown.

## Tradeoffs / limitations

- RAM budget uses on-disk size as a load estimate (≈ weights; KV-cache/overhead not
  modeled; conservative 0.8 default). Online accounting uses real RSS, incl. in-flight
  loading estimates.
- Load is slow (~tens of seconds for a 35B); the row shows `loading` until `/health` +
  `/v1/models` confirm. No progress %.
- **External** GGUF processes: killing the single external pid may orphan an mlx-spawned
  llama.cpp grandchild (we don't kill external _groups_ for safety). Managed GGUF
  reaps the whole group. Documented.
- pid-reuse on external kill is narrowed (snapshot + immediate re-verify of
  command/args/start-time) but remains best-effort.
- `readProcessRows` truncates stdout at 2 MB; on a very busy machine an mlx row past the
  cut could briefly vanish (one-tick flicker). Self-heals next tick.
- `disableAuthentication`/`T3CODE_DISABLE_AUTH` exposes load/unload to every client
  (higher blast radius than the read-only indicator) — inherent to open-access mode.

## Design review (2 rounds — applied, exited)

Round 1: three adversarial reviewers (correctness/races, simplicity/scope,
safety/security). Round 2: focused verification of the fixes. All applied; exited at
quiescence. Net changes: scope cut to mlx-serve-only (dropped generic providers +
dedupe); leaner settings (loopback host + fixed port range as constants); inline
collapsible sidebar section instead of hover popover; `modelId` allowlist + realpath
confinement; `unload` restricted to snapshot-verified + immediately re-verified pids
(refuse self/non-mlx); `load` serialized under a semaphore with in-flight budget
accounting; correlate-by-path not id; managed kill via `Scope.close` (spawner reaps the
detached group — no redundant manual `-pgid`); shutdown finalizer; `status` optional +
keep `loaded`; single synthetic provider group preserves the sample shape.

## Follow-ups deferred

- Generic read-only providers (vLLM/llama.cpp) + their dedupe.
- Per-model `port` pinning / `disabled` hiding.
- Ollama managed provider (native load/unload).
- Live load progress / child logs; offline metadata from each dir's `config.json`;
  settings UI for `localModels`; auto-restart of a crashed managed model; per-client
  rate-limit on `load`.

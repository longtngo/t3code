# LLM Loaded Indicator — design (2026-06-15)

## Goal

Add an at-a-glance indicator to the branch-toolbar usage/host-metrics group showing
whether a **local LLM is loaded**. Label `LLM` + a status dot (green = ≥1 model
resident in memory, gray = none) + a resident-count. Hover **or** click opens a
scrollable popover listing the loaded/available models **grouped by provider**, with
each provider's endpoint. The set of providers/endpoints is config-driven and
documented in a runbook; each is probed the same way.

Mirrors the existing **host-metrics** feature end-to-end (streaming RPC → server
sampler → client hook → toolbar widget with popover), so it inherits its
subscribe-only-while-watched, tab-visibility-pause, and fixed-width-no-jitter
behaviors.

## Scope (locked with user)

- **Provider:** `mlx-serve` only in v1 (extensible via config). Confirmed running
  locally at `127.0.0.1:8765`, model `Qwen3.6-35B-A3B-4bit`.
- **Config:** a settings list of `{ name, baseUrl }` entries, default-seeded with
  mlx-serve; runbook documents how to add providers and how to run each.
- **Runtime:** server-side polling, streamed to the toolbar like host metrics
  (avoids browser CORS; works when the UI is remote from the model host).
- **Resident detection:** resident-in-memory where the provider reports it
  (mlx-serve `/v1/models` → `loaded: true`), else treat a served/listed model as
  loaded.

## mlx-serve probe (empirically verified)

`GET http://127.0.0.1:8765/v1/models` returns OpenAI-shaped data, enriched:

```jsonc
{"object":"list","data":[{
  "id":"Qwen3.6-35B-A3B-4bit","object":"model","owned_by":"mlx-serve",
  "loaded":true,"state":"ready","bytes_resident":1310720,"bytes_on_disk":null,
  "capabilities":["chat","tool_use","streaming","reasoning","json_schema"],
  "meta":{"architecture":"qwen3_5_moe","quantization":"4-bit",
          "context_length":163223,"is_moe":true, ...}}]}
```

- `loaded` + `state` → resident signal (no `/api/ps` needed; mlx-serve has none).
- `meta.quantization` / `meta.context_length` / `meta.is_moe` → reliable badges.
- `bytes_resident` is **unreliable** here (1.25 MB vs ~19 GB real RSS) → size is
  shown only when `bytes_resident` is present and plausible (> 1 GB), else omitted.
- `GET /health` → `{"status":"ok"}` (liveness; optional, `/v1/models` already
  doubles as a reachability probe).
- mlx-serve is **one model per process/port** — multiple models = multiple ports,
  so each `{name,baseUrl}` is its own provider group in the popover.

## Approach

A new streaming subscription `subscribeLlmModels` parallel to `subscribeHostMetrics`.

### Contract (`packages/contracts/src/rpc.ts`)
New schemas:
- `LlmModel` = `{ id, loaded: boolean, state?: string, sizeBytes?: number,
  quantization?: string, contextLength?: number, isMoe?: boolean,
  capabilities?: readonly string[] }`
- `LlmProvider` = `{ name, baseUrl, reachable: boolean, error?: string,
  models: readonly LlmModel[] }`
- `LlmModelsSample` = `{ ts: number, providers: readonly LlmProvider[] }`
- `WsSubscribeLlmModelsRpc` = `Rpc.make(WS_METHODS.subscribeLlmModels, { payload:{
  intervalMs?: number }, success: LlmModelsSample, error:
  EnvironmentAuthorizationError, stream: true })`, added to `WsRpcGroup` and
  `WS_METHODS` (`subscribeLlmModels`) — a 3-site change (enum @ `rpc.ts:209`,
  `Rpc.make`, group list @ `rpc.ts:658-717`).
- **Each schema gets its `typeof X.Type` export** (mirror `rpc.ts:644`), since the
  client lib and the sampler import these types.

### Settings (`packages/contracts/src/settings.ts`)
Add to `ServerSettings`:
```
llmProviders: Schema.Array(Schema.Struct({
  name: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
})).pipe(Schema.withDecodingDefault(Effect.succeed([
  { name: "mlx-serve", baseUrl: "http://127.0.0.1:8765" },
])))
```
Default seeds mlx-serve at the live port. Empty array ⇒ feature degrades to "no
providers configured" (gray dot, popover explains).

### Server sampler (`apps/server/src/diagnostics/LlmModels.ts`, new)
Mirror `HostMetrics.ts`:
- `llmModelsStream(intervalMs)` → `Stream.unfold` that every tick reads the
  current `ServerSettings.llmProviders`, probes each endpoint **concurrently and
  independently** (one failing/unreachable provider yields `reachable:false` +
  `error`, never fails the sample), and emits an `LlmModelsSample`.
- Probe uses the Effect **`HttpClient.HttpClient`** (from `effect/unstable/http`,
  satisfied ambiently by `FetchHttpClient.layer` — **NOT raw `fetch`**, which the
  server source never uses and which won't interrupt/trace correctly). Pattern:
  `providerMaintenance.ts:403-406` — `const client = yield* HttpClient.HttpClient;
  HttpClientRequest.get(baseUrl + "/v1/models").pipe(setHeader("accept","application/json"))`,
  bounded by `Effect.timeout`/`timeoutOption` (~1.5 s) like `readGpu` bounds the
  spawn (`HostMetrics.ts:110-115`). Parse OpenAI `data[]`, map mlx-serve fields.
  Resident = `loaded === true` when the field exists, else `true` (served = loaded).
  `HttpClient` is declared in the stream's `R` channel.
- Default cadence **4000 ms** (model load state changes slowly; cheaper than host
  metrics' 1500 ms). Floor 1000 ms. First tick bootstraps fast (~300 ms). The
  default/floor live in the **sampler**, not the hook (mirrors host-metrics, where
  `useHostMetrics` passes no interval).
- Reads settings via `ServerSettingsService.getSettings` each tick (cheap `Ref.get`)
  so config edits take effect without resubscribe. **`getSettings` is fallible
  (`ServerSettingsError`); the per-tick read MUST be caught** (`Effect.catch` →
  fall back to `DEFAULT_SERVER_SETTINGS` / last-known) so a settings read can never
  terminate the stream — the contract error channel is `EnvironmentAuthorizationError`
  only, and the stream's declared error type is `never`. Pattern: `ws.ts:277-284`.

### Server wiring (`apps/server/src/ws.ts`)
- Handler at the RpcServer methods block, mirroring `subscribeHostMetrics`:
  `[WS_METHODS.subscribeLlmModels]: (input) => observeRpcStreamEffect(WS_METHODS.subscribeLlmModels, Effect.succeed(LlmModels.llmModelsStream(input.intervalMs ?? 4000)), { "rpc.aggregate": "server" })`.
  **Use the locally-rebound `observeRpcStreamEffect` (`ws.ts:337-350`) — NOT the raw
  `instrumentRpcStreamEffect` import alias (`ws.ts:68`)** — because the rebound
  version injects the `authorizeEffect(requiredScopeForMethod(...))` scope gate;
  calling the raw alias bypasses auth. The stream's `R` (`ServerSettingsService` +
  `HttpClient`) is satisfied by the ambient root layer in `server.ts:457-474`
  (`RuntimeCoreDependenciesLive` provides settings, `FetchHttpClient.layer` the
  client) — leaks through `WsRpcGroup`'s aggregate requirements exactly like
  host-metrics' `ChildProcessSpawner`.
- `[WS_METHODS.subscribeLlmModels, AuthOrchestrationReadScope]` in
  `RPC_REQUIRED_SCOPE`.

### Client wiring
- `packages/client-runtime/src/wsRpcClient.ts`: add `llmModels.subscribe` to the
  interface + impl (mirror `hostMetrics`).
- `packages/contracts/src/ipc.ts`: add `llmModels.subscribe` to `EnvironmentApi`.
- `apps/web/src/environmentApi.ts`: wrapper → `rpcClient.llmModels.subscribe`.

### Client UI
- `apps/web/src/lib/llmModels.ts`: re-export the three `.Type` types; helpers
  `countResident(sample)` and `formatContext(n)` ("163k"). **No `formatModelSize`** —
  call `formatBytes` (`lib/hostMetrics.ts:17`) directly. Reuse `usageLevel` from
  `lib/usage.ts` where a level is needed.
- `apps/web/src/hooks/useLlmModels.ts`: mirror `useHostMetrics` — localStorage
  toggle `t3code:llm-models-enabled` (default on), visibility-pause, returns
  `{ sample, streaming }`. Subscribe with no interval arg (sampler owns the default).
- `apps/web/src/components/chat/LlmModels.tsx`: the widget. **Copy
  `HostMetrics.tsx:232-280` structure verbatim** — two controls:
  1. **Popover trigger** (uncontrolled): `<PopoverTrigger openOnHover delay={150}
     closeDelay={0} render={<button aria-label="Local models" .../>} />`. base-ui's
     default `stickIfOpen:true` already gives "hover OR click opens, click pins it
     open" — **no controlled `open`/`onOpenChange` state, no custom hover handlers.**
  2. **Separate sibling live-dot button** (`aria-label="Pause local-model probing"`,
     `title="Live — click to pause"`) toggling the stream, exactly like
     `HostMetrics.tsx:267-280`.
  - Trigger content is **fixed-shape**: `LLM` label + dot (green+pulse if
    residentCount>0 else gray) + resident count rendered in a **fixed-width slot**
    (reuse `METER_VALUE_SLOT` from `usage.ts:425`), showing the number or `0`/`—`
    placeholder — **never conditionally mounted** (avoids the documented toolbar
    wrap-jitter; mirrors `MetricSegment`'s null handling at `HostMetrics.tsx:45-53`).
    All variable-width content (model names, "unreachable" tags, meta chips) lives
    **only inside the popover**, never the trigger.
  - Popover (`PopoverPopup tooltipStyle side="top" align="center"`): header
    "Local models" + live dot; scrollable body grouped by provider (name · baseUrl,
    "N loaded"); each model row: dot (green resident / gray idle), name, meta chips
    (quant / MoE / "Nk ctx" / state), optional size; unreachable provider shows an
    orange "unreachable" tag + note; footer "N resident · M available".
  - **Disabled (paused) collapsed state** mirrors `HostMetrics.tsx:208-221`: a single
    button (`aria-label="Enable local-model probing"`) with a gray dot + `models
    paused` text (`hidden sm:inline`). Empty (no resident, providers up) and
    connecting states mirror HostMetrics' popover bodies.
- `apps/web/src/components/BranchToolbar.tsx`: render `<LlmModels />` after
  `<HostMetrics />` inside the existing wrap container; add the hook calls.

## Alternatives considered

- **Client-side probing** — rejected: CORS on mlx-serve, and breaks when the web UI
  is served remotely from the model host. Server-side matches host-metrics and the
  rest of the app's remote-capable model.
- **Auto-scan `ps` for mlx-serve `--port`** — rejected for v1: fragile, macOS-only
  parsing, and surprising. Config list is explicit and runbook-documented; auto-scan
  can be a later additive source.
- **Reuse `/health` only** — insufficient: doesn't enumerate models or resident
  state. `/v1/models` is the one probe that carries everything.
- **One-shot RPC + manual refresh (like accountUsage.refresh)** instead of a
  stream — rejected: the dot should reflect load/unload live; the stream's
  subscribe-only-while-visible already bounds cost, and a 4 s cadence is cheap.

## Tradeoffs / limitations

- v1 is mlx-serve-shaped. Generic OpenAI `/v1/models` providers (vLLM, llama.cpp)
  will list models but can't report resident state → shown as "loaded" (served).
  Acceptable per locked decision; Ollama `/api/ps` resident support is a follow-up.
- `bytes_resident` from mlx-serve is unreliable → size often omitted. Meta badges
  (quant/ctx/MoE) carry the useful info.
- Polling the settings each tick is O(providers) fetches every 4 s while the toolbar
  is visible; negligible for a handful of localhost endpoints.

- The default seeds a **non-empty** provider, so every install gains a localhost
  probe loop while the toolbar is visible (subscribe-only-while-visible bounds it).
  "Default-on" is intentional per locked scope, not opt-in.

## Design review (round 1 — applied, exited)

Two adversarial reviewers (correctness/compat + simplicity/UX) against the real
mirrored code. All findings applied above; both confirmed the architecture is sound,
so one round sufficed. Key fixes folded in: use `observeRpcStreamEffect` (not the raw
alias) to keep the auth-scope gate; Effect `HttpClient` instead of raw `fetch`; catch
`ServerSettingsError` per tick so the stream can't die; add `.Type` exports; rely on
base-ui's default `stickIfOpen` for hover+click+pin (no controlled state); fixed-width
resident-count slot to avoid wrap-jitter; drop `formatModelSize` (reuse `formatBytes`);
add the separate pause toggle + `aria-label`s + paused collapsed state to fully mirror
HostMetrics.

## Follow-ups deferred

- Ollama provider probe (`/api/tags` + `/api/ps` resident state).
- Generic OpenAI-compatible provider kind (vLLM/llama.cpp) with served≈loaded.
- Settings UI to edit `llmProviders` (v1 is file-edit + runbook).
- Runbook `~/reports/runbooks/local-llm-providers.md` documenting how to run each
  provider and the probe contract (written at release).

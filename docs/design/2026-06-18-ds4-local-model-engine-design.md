# ds4 local-model engine + mlx defaultArgs update — 2026-06-18

## Goal

Two changes driven by the 2026-06-18 update to the local-LLM runbook
(`~/reports/runbooks/local-llm-providers.md`):

1. **Drop the obsolete `--no-pld`** from the default mlx-serve launch args. mlx-serve
   26.6.8 added adaptive Prompt-Lookup Decoding; on 26.6.10 PLD-on ties or beats
   `--no-pld` everywhere and is fastest for Qwen. New default `defaultArgs`:
   `["--reasoning-budget", "0"]`.

2. **Add ds4 / DeepSeek V4 Flash as a second local-model engine** the sidebar manager
   can discover, load, probe, and unload — alongside mlx-serve. ds4-server
   (`~/src/personal/ds4/ds4-server`) is an OpenAI/Anthropic-compatible HTTP server that
   serves `/v1/models` + `/v1/chat/completions`, so it slots into the existing probe and
   sample contract with no new wire protocol.

Non-goal: wiring ds4 as a _chat agent driver_ (the codex/claude/cursor-style provider
instances are full CLI integrations, not generic OpenAI endpoints). "Run DeepSeek V4 in
t3code" here means: manage the ds4-server process from the sidebar exactly as we manage
mlx-serve. Selecting a local endpoint as the active generation backend is a separate,
larger feature (deferred follow-up).

## Validated premises (Hard Rule 8)

- **ds4-server is a long-lived OpenAI-compatible HTTP server.** `ds4_server.c:6`
  ("OpenAI/Anthropic compatible local server"); routes `/v1/models`,
  `/v1/chat/completions`, `/v1/messages`, `/v1/responses` present in source;
  `--host`/`--port` (default `127.0.0.1:8000`), `-m/--model FILE`, `--ctx`, `--power`.
  `ds4-server --help` runs (binary builds & executes). ✓
- **The existing `/v1/models` probe (`llmProbe.ts`) is engine-agnostic** — it tolerates a
  body without mlx's enrichment fields, treating a listed model as loaded. ds4's
  `/v1/models` works unchanged. ✓
- **The contract already carries an array of providers** (`LlmModelsSample.providers`)
  and the web UI already flattens `providers.flatMap(p => p.models)` — so a second engine
  is additive at the contract/stream/UI layers. ✓
- **ds4 models are single GGUF _files_**, not directories. Present on disk:
  `~/src/personal/ds4/gguf/DeepSeek-V4-Flash-…-imatrix-fixed.gguf` (a regular file,
  ~91 GiB / 97.6 GB on disk). The `ds4flash.gguf` symlink lives in the repo _root_
  (`~/src/personal/ds4/`), which is **outside** `modelsDir`, so it is never discovered —
  the glob only sees the real file in `…/gguf/`. ✓
- **Suspected pre-existing bug to confirm+fix:** in `LlmServeManager.list` step 2 a
  _managed_ running process maps to status `loading`/`stopping` only — `LaunchState` has
  no `online`, and the `probeMeta` result is fetched but ignored for status. A managed,
  fully-serving model therefore appears to stay on the amber "loading" spinner forever.
  This must be confirmed live (load a real gemma model, observe the dot) and fixed, since
  ds4's ~13 s startup would otherwise look permanently stuck. Fix = probe-driven
  readiness (below).

## Approach

### Engine descriptors (closed set)

Introduce an `Engine` value type — a _closed_ set (`mlx-serve`, `ds4`), never a
user-supplied command template (that would reintroduce the arg-injection surface the
current code carefully defends). Each descriptor holds the per-engine behaviour:

```ts
interface Engine {
  readonly id: "mlx-serve" | "ds4"; // also the provider display name
  readonly executable: (cfg) => string; // resolved binary (expandTilde'd)
  // Enumerate candidate models + their RAM estimate in one pass (collapses the old
  // listModels + estimateBytes): dir-scan + dir-sum (mlx) | *.gguf glob + statSync (ds4).
  readonly discover: (cfg) => { id: string; path: string; estBytes: number }[];
  readonly matches: (row: ProcessRow) => ManagedProc | null; // ps matcher + model/port extract
  readonly buildArgs: (a: { host; port; modelPath; defaultArgs; perModelArgs }) => string[];
  // Per-engine load allowlist + realpath confinement (mlx: subdir; ds4: *.gguf file).
  readonly resolveModelPath: (cfg, modelId) => string | null; // null ⇒ not found / escapes dir
}
```

- **mlx-serve** (unchanged behaviour): executable `mlx-serve`; models = subdirectories of
  `modelsDir`; est = sum of top-level file sizes; ps matcher = current
  `parseMlxProcesses` (`mlx-serve … --serve … --model PATH … --port N`, `port: null` if
  omitted); args =
  `["--serve", ...defaultArgs, ...perModel, "--host", H, "--port", P, "--model", PATH]`;
  `resolveModelPath` = the current allowlist + `dirname(realpath) === realpath(modelsDir)`
  check (LlmServeManager.ts:342-354).
- **ds4**: executable from `cfg.ds4.binaryPath` (tilde-expanded); models = `*.gguf` files
  in `cfg.ds4.modelsDir`, id = filename; est = `statSync(file).size`; ps matcher anchors
  on the **executable** and a mandatory model-file token —
  `(^|/|\s)ds4-server(\s|$)` AND `(-m|--model)\s+(\S+\.gguf)` — and defaults the port to
  **8000** (ds4-server's documented default) when `--port` is absent, so externally
  started ds4 can still be probed; args =
  `[...defaultArgs, ...perModel, "--host", H, "--port", P, "-m", PATH]` (no `--serve`);
  `resolveModelPath` = allowlist against the `*.gguf` glob + the **same realpath
  confinement** as mlx (`dirname(realpath(file)) === realpath(modelsDir)`), so a symlink
  inside `modelsDir` whose target escapes the dir is rejected (acceptable; the user's
  model is a real file in `…/gguf/`).

The manager iterates the **enabled** engines, building one `LlmProvider` snapshot per
engine, and returns `providers: LlmProvider[]` instead of a single `provider`. The
diagnostics stream spreads them straight into `LlmModelsSample.providers`.

**Spawn cwd (found in the live smoke).** ds4-server resolves its `metal/` Metal shaders
_relative to its working directory_ — launched from elsewhere it aborts with "metal
backend unavailable; aborting startup". So the descriptor carries a `cwd(cfg)`: ds4 returns
`dirname(binaryPath)` (the ds4 repo root, where `metal/` lives); mlx returns `undefined`
(PATH tool, no cwd-relative assets). The spawn passes `cwd` through to `ChildProcess.make`.

### Model id / engine resolution for load

`modelId` stays the human id (mlx: dir basename; ds4: gguf filename incl. `.gguf`). The
**load RPC contract is unchanged** (still `{ modelId }`) — the server resolves the engine
itself by scanning each enabled engine's discovered model set for `modelId` (mlx dirs have
no `.gguf` suffix, ds4 files do, so a basename collision is effectively impossible; the
scan runs under the existing load semaphore, so no race; deterministic engine order
mlx→ds4, first match wins). Keeping the RPC byte-identical avoids a second code path and
any client/server version-skew surface.

`LlmModel` gains **one** optional `engine` field — not for load routing but for _display_:
the UI needs it to label rows (`ds4 · MoE · …`), build collision-free React keys, and word
the unload dialog ("stops the `<engine>` process"). The server already knows it (it built
the provider); the client cannot otherwise derive it.

### Probe-driven online status (fixes the suspected bug)

Replace the entry-state-only status in `list` step 2 with probe-driven readiness:

```
status =
  entry?.state === "stopping" ? "stopping"
  : (probeReachable ? "online" : "loading")   // in ps but HTTP server not answering ⇒ loading
```

**Critical signal correction (review C1):** `probeReachable` must be the probe's
`reachable` boolean, **not** `models[0] != null`. The existing `probeMeta` helper returns
`p.models[0] ?? null`, which conflates "unreachable" with "reachable but lists zero
models" — and ds4 (like any server) answers `/v1/models` with an empty `data: []` during
the window after the socket binds but before weights register, which would pin it to
"loading" forever (the very bug we're fixing, relocated). So add a sibling
`probeReachable(port): Effect<boolean>` that returns `probeProvider(...).reachable`, and
keep `probeMeta` solely for metadata enrichment. A process in `ps` but whose HTTP server
hasn't bound yet (mlx loading weights, ds4 wiring ~91 GB) shows "loading" until the probe
is reachable, then flips to "online". `LaunchState` stays `loading | stopping` (no new
`online` member — readiness is derived from the probe, not stored). Managed and external
procs share this logic; `managed` is independent of status. RAM use counts a proc once it
is online or stopping (unchanged).

### RAM budget — global across engines

The budget remains a single `ramBudgetBytes` (0 ⇒ 80 % of total memory). `ramUsedBytes`
and the load admission check sum RSS across **all** engines' online/loading processes, so
loading the ~91 GB ds4 model is refused when mlx models already occupy the budget, and vice
versa. The port window (8765–8799) is shared and allocated uniquely across engines;
externally started ds4 on its default 8000 is out of window and never collides.

**Inflight double-count fix (review m2):** the admission check sums `online RSS (from ps)`

- `inflight estBytes (registry entries with state=loading)` + `this estBytes`. A launch
  that is _already visible in ps_ yet still registry-`loading` is counted twice (its real
  RSS in the ps sum **and** its estimate in the inflight sum) during the overlap window —
  pre-existing, but ds4's ~13 s startup and ~91 GB estimate make a spurious
  `budget_exceeded` on a concurrent second load likely. Fix: exclude registry-loading
  entries whose `pid` is already present in `procs` from the inflight sum.

### Settings shape (back-compatible)

Keep the existing top-level `localModels.{modelsDir, ramBudgetBytes, defaultArgs,
perModel}` as the **mlx-serve** engine config (no migration; existing settings files keep
working; `defaultArgs` default loses `--no-pld`). Add an optional nested `ds4` block whose
**contract defaults are generic and `enabled: false`** — a shared package must not bake one
person's filesystem layout (`~/src/personal/ds4/…`) into a cross-fork default, and other
forks / CI / settings snapshot tests must decode to something neutral (review m4):

```jsonc
"localModels": {
  "modelsDir": "~/llm/models",              // mlx-serve (unchanged)
  "ramBudgetBytes": 0,
  "defaultArgs": ["--reasoning-budget", "0"],
  "perModel": {},
  "ds4": {                                   // NEW — opt-in second engine
    "enabled": false,                        // default off; generic paths
    "binaryPath": "ds4-server",              // resolved on PATH by default
    "modelsDir": "~/ds4/gguf",
    "defaultArgs": [],
    "perModel": {}
  }
}
```

When `ds4.enabled` is false (the default everywhere) the engine is skipped entirely — no
glob, no probe, no provider row. To actually surface ds4 for _this_ user without a settings
UI, the implementation **seeds their live server-settings file** (the runtime JSON that
`server.updateSettings` writes — not the shared contract) with an enabled `ds4` block
pointing at their real paths (`binaryPath: ~/src/personal/ds4/ds4-server`,
`modelsDir: ~/src/personal/ds4/gguf`), merged so existing settings are preserved. Personal
config lives in the personal settings file; the shared contract stays neutral. If the
binary or dir is ever absent, discovery returns `[]` and the engine contributes nothing —
no error, no spurious probing. The asymmetry (mlx at top level, ds4 nested) is deliberate:
it avoids a settings migration for the established mlx config.

### UI

`SidebarLocalModels` already flattens providers. Changes:

- Key rows by `engine + (modelId ?? id)` (avoid cross-engine key collisions).
- Show a small engine tag in the meta line when more than one engine has models (e.g.
  `ds4 · MoE · 91 GB`), so the user can tell DeepSeek from the mlx models.
- Pass `model.engine` into `actions.load`.
- Generalize the confirm-dialog copy from "stops the mlx-serve process" to "stops the
  `<engine>` process".

## Files touched

- `packages/contracts/src/settings.ts` — drop `--no-pld`; add `Ds4Settings` + nested `ds4`
  field on `LocalModelsSettings` (generic defaults, `enabled:false`).
- `packages/contracts/src/rpc.ts` — optional `engine` on `LlmModel` (display only; load
  payload unchanged); generalize the `LlmServeError.kind` literal `not_mlx_process` →
  `not_managed_process` (engine-neutral).
- `apps/server/src/llm/LlmServeManager.ts` — engine descriptors; multi-engine `list`
  returning `providers[]` (internal `LlmServeListResult.provider` → `providers[]`);
  probe-driven status via a new `probeReachable`; global budget with the inflight
  double-count fix; engine-resolved load; generalized unload re-verification across **all
  enabled** engine matchers; per-engine supervisor exit-reason text; drop `--no-pld` from
  the `readConfig` catch-cause fallback (line 198) too.
- `apps/server/src/diagnostics/LlmModels.ts` — spread `providers` from the manager.
- `apps/web/src/components/sidebar/SidebarLocalModels.tsx` — engine-safe keys, engine
  label in the meta line, dialog copy ("stops the `<engine>` process").
- `apps/web/src/lib/llmModels.ts` (+ test) — carry `engine` through the flattened model
  type; counts already operate over flattened models.
- A small startup/settings seed for this fork's live config (enabled ds4 block) — applied
  to the runtime settings file, NOT the shared contract.
- Tests: `LlmServeManager.test.ts` (ds4 ps matcher incl. default-port-8000 + executable
  anchoring, gguf discovery, engine resolution, probe-driven status, inflight de-dup),
  contract/UI tests as needed.

## Alternatives considered

- **Generic command-template engine (settings-defined executable + arg template).**
  Rejected: reintroduces arbitrary-command / arg-injection from settings, which the
  current code is carefully hardened against; a closed engine set keeps the executable an
  allowlist.
- **A second `LlmServeManager` service instance for ds4.** Rejected: duplicates the
  registry/supervisor/budget logic and splits RAM accounting across two services; the
  budget must be global, which is trivial in one manager and awkward across two.
- **Bolt ds4 on as hardcoded parallel functions (no Engine abstraction).** Rejected: more
  duplicated code than the descriptor, and every future tweak doubles.
- **Restructure settings into `localModels.engines[]` (symmetric).** Rejected for now:
  forces a migration of the established mlx config for no functional gain; the nested
  `ds4` block is back-compatible. Revisit if a third engine appears.
- **Wire ds4 as a chat/generation provider instance.** Out of scope (see Goal);
  larger feature, deferred follow-up.

## Tradeoffs & limitations

- Asymmetric settings (mlx top-level, ds4 nested) is slightly inelegant but
  migration-free.
- **Persisted `--no-pld` survives (review m1).** `Schema.withDecodingDefault` only supplies
  a default when the field is _absent_. A user who already persisted
  `localModels.defaultArgs` keeps `["--reasoning-budget","0","--no-pld"]` verbatim; the new
  default never reaches them. This is intentional (no migration), and `--no-pld` is still a
  valid flag — behaviour is merely stale, not broken. New/unset configs get the new default.
- **ds4 model ids are restricted to `MODEL_ID_RE` (review m2).** gguf filenames with
  spaces, `+`, `(`, `,`, or non-ASCII are rejected by `isValidModelId` and will be
  un-loadable. The user's real file passes; broadening the validator (quote rather than
  reject) is a deferred follow-up.
- **`ds4.binaryPath` spawns a settings-specified executable (review m3).** Unlike mlx's
  fixed `mlx-serve` name, ds4 runs an arbitrary path from settings. This is **not** a
  privilege escalation: `llmServeLoad` and `server.updateSettings` share the same
  `AuthOrchestrationOperateScope` (ws.ts), so anyone who can load can already write
  settings. If those scopes are ever split, `binaryPath` must move behind the
  settings-write scope. The implementation validates the binary exists before spawn.
- Two externally started ds4 processes both defaulting to port 8000 is user error
  (only one binds); the manager treats duplicate-port external processes as undefined
  (review M3, correctness). Managed launches always get a unique in-window port.
- The live ds4 smoke loads ~91 GB; perform it deliberately on the M5 Max (128 GB) and
  unload immediately.

## Follow-ups deferred

- Settings UI for `localModels` (no editor yet; both engines configured via JSON).
- Selecting a local endpoint as the active text-generation/chat backend.
- ds4 `--think`/`--nothink` and `--power` per-model presets surfaced in the UI.
- Symmetric `engines[]` settings if/when a third engine lands.

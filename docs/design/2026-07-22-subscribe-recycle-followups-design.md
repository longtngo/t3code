# subscribeThread OOM fix — the three drained follow-ups — 2026-07-22

Follow-ups discovered by the `batchWithinStackSafe` OOM fix (`personal` af4c5647a,
report `~/reports/t3code/2026-07/2026-07-21/2026-07-21-subscribe-thread-batch-stack-safe.md`).
Each code item ships on its own branch; the upstream bug report is external.

## Goal

1. **FU1 (`cleanup/remove-subscription-recycle`)** — remove `recycleSubscriptionStream`
   entirely. Its `Stream.take(N)` recycle was introduced (2026-07-18, d35adf62d /
   d6dbcda10) as the OOM cure under a **falsified** premise: that the `RpcServer`
   request fiber grows its continuation `_stack` one frame per streamed element. It
   does not — and the real leak (`Stream.groupedWithin`→`aggregateWithin`→
   `stepToBuffer` idle-tick recursion, `subscribeThread` only) is fixed elsewhere by
   `batchWithinStackSafe`. The recycle now guards nothing real; it is dead-weight
   churn (periodic full-state resubscribes on 6 streams).
2. **FU2 (external)** — report the upstream effect `aggregateWithin`/`stepToBuffer`
   stack-safety bug with a minimal repro. No code lands in this repo; the repro +
   issue draft are produced and held for posting confirmation (outward-facing).
3. **FU3 (`chore/lint-guard-stream-aggregate`)** — a custom oxlint rule that forbids
   re-introducing `Stream.groupedWithin` / `Stream.aggregate*` in the codebase, so
   the fixed leak cannot silently return.

## Load-bearing premises (validated BEFORE design — Hard Rule 8)

- **P1 — `runForEachArray`/`fromPull` are trampolined (no per-element `_stack`
  growth).** If false, removing the recycle would reintroduce a slow per-element
  leak on the streams where the recycle is the *only* bound (host-metrics,
  llm-models, vcs-status, terminal, shell). **VERIFIED** against the installed
  patched effect source: `runForEachArray = dual(2, (self, f) =>
  Channel.runForEach(self.channel, f))` — it delegates to the trampolined channel
  executor, no per-element continuation push. Corroborated empirically: the
  `batchWithinStackSafe` path (also `Channel`-executor / `fromPull`) held a
  **24 h 15 m flat heap** (median 254 MB) under real streaming load, and the busy
  streams stayed flat *well within* a single 20000-event recycle window — so the
  bound was not doing the flattening. The recycle guards a mechanism that does not
  exist.
- **P2 — the local effect patch does not already fix `aggregateWithin`.** If it
  did, FU2 would be moot. **VERIFIED** — `patches/effect@4.0.0-beta.78.patch`
  touches only `unstable/rpc/RpcClient` (request/connection lifecycle hooks); it
  does not touch `Stream`/`aggregateWithin`/`stepToBuffer`. The upstream bug is
  real and unpatched here.
- **P3 — no live call-sites of the banned methods remain.** If any real
  `Stream.groupedWithin(...)`/`aggregate*(...)` call existed, an `error`-level rule
  would break the build. **VERIFIED** — the only remaining textual mentions are in
  *comments* (`ws.ts` NOTE, `batchWithinStackSafe.ts` doc); oxlint matches AST
  call-expressions, not comments, so an `error` rule is safe today.

## FU1 — remove `recycleSubscriptionStream`

**Approach:** delete the module + its test; unwrap all 6 `ws.ts` call sites back to
the bare stream; drop the `WS_SUBSCRIPTION_MAX_EVENTS` module const, the
`resolveSubscriptionRecycleLimit`/`recycleSubscriptionStream` imports, and the
`T3CODE_WS_SUBSCRIPTION_MAX_EVENTS` env plumbing. `subscribeThread` keeps its
`batchWithinStackSafe` (the real fix) untouched — only the outer `Effect.map(stream
=> recycleSubscriptionStream(stream, N))` wrapper is removed.

**Behavior delta:** long-lived subscription streams no longer end-and-resubscribe
every N events. This removes accidental churn, not a designed mechanism — the
recycle was never a correctness/resync feature (consumer-lag resync is
`boundedSubscriberStream`'s job, retained). Net effect on low-bandwidth/mobile
clients is *positive*: fewer forced full-state re-snapshots.

**Alternatives rejected:**
- *Keep it as "belt-and-braces"* — it costs real bandwidth/CPU (periodic full
  re-snapshot ×6 streams) to defend against a mechanism proven not to exist;
  keeping falsified-premise code is the churn the report flagged for removal.
- *Keep only the env kill-switch* — nothing to switch off once the wrapper is gone.

**Files:** delete `apps/server/src/recycleSubscriptionStream.ts` (+ `.test.ts`);
edit `apps/server/src/ws.ts` (remove import, const, 6 call sites, env doc).

## FU3 — lint guard against `Stream.groupedWithin`/`aggregate*`

**Approach:** a new rule `t3code/no-unsafe-stream-aggregate` in the existing custom
plugin `oxlint-plugin-t3code`, mirroring the two existing rules' shape (`defineRule`
+ `createOnce` + AST visitor + a co-located `.test.ts` driving the real `oxlint`
binary via `createOxlintRuleHarness`). `no-manual-effect-runtime-in-tests` already
uses the exact visitor pattern (unwrap callee → `MemberExpression` → object
`Identifier` === `Effect` + property in a `Set`); this rule swaps `Effect`→`Stream`.

**Rule:** flag a `CallExpression` whose callee is a `MemberExpression`
`Stream.<method>` where `<method> ∈ { groupedWithin, aggregate, aggregateWithin }`
— the three effect exports that lower to the non-stack-safe `aggregateWithin`→
`stepToBuffer` schedule loop (source-verified in the installed
`effect@4.0.0-beta.78 dist/Stream.js`: `groupedWithin`:5595 and `aggregate`:5838
both delegate to `aggregateWithin`:5868, whose `stepToBuffer`:5887 self-recurses on
idle ticks). `aggregateWithinEither` is included in the ban `Set` as **forward-
defensive only** — it is NOT an export in this effect version (banning it is a
harmless no-op that pre-empts a future re-introduction), and the rule comment says
so. The visitor also flags the `.pipe(Stream.groupedWithin(...))` form — same
callee shape, one visitor covers both. Message points at `batchWithinStackSafe` as
the stack-safe replacement.

**Deliberately NOT banned:** `Stream.debounce` and `Stream.throttle` — they do NOT
use the `stepToBuffer` loop (`debounce` uses `transformPull`+latches:5337,
`throttle` uses `throttleEffect`:5435) and there are **3 live `Stream.debounce`
call sites** (`serverSettings.ts:558`, `ws.ts:1643`, `keybindings.ts:600`); an
over-broad ban would break the build and falsify P3.

`Stream` is always imported as `import * as Stream from "effect/Stream"` (or the
`import { Stream } from "effect"` namespace), so an object-identifier check on
`Stream` is sufficient and precise; no type information required (the config runs
`typeAware: false`).

**Wiring:** register in `oxlint-plugin-t3code/index.ts`; add
`"t3code/no-unsafe-stream-aggregate": "error"` to `vite.config.ts` `lint.rules`.
Global scope (not server-only): the combinators are unsafe anywhere in *this*
codebase and there are no legitimate uses; a global `error` is simpler and stricter
than a path override, and P3 confirms nothing breaks. (Registration path verified
correct: `jsPlugins: ["./oxlint-plugin-t3code/index.ts"]` + plugin `meta.name:
"t3code"` ⇒ rule key `t3code/<name>`; the existing
`"t3code/no-manual-effect-runtime-in-tests": "error"` proves an `error`-level
`t3code/*` rule fires in `vp lint`/CI.)

**Alternatives rejected:**
- *`no-restricted-syntax` (eslint-style)* — **does not exist in oxlint at all**
  (verified against the native binding `@oxlint/binding-darwin-arm64@1.67.0`: it
  ships `no-restricted-imports` but no `no-restricted-syntax`). The "simpler
  one-liner" is unavailable, so a first-class custom-plugin rule is the correct and
  proportionate mechanism, not gold-plating.
- *Ban only `groupedWithin`* — `aggregate`/`aggregateWithin` share the same
  `stepToBuffer` loop; ban the family.

## FU4 — local effect patch (fix the bug in-tree instead of reporting it)

**User decision (2026-07-22):** do NOT post upstream; keep everything local and
"make sure we have a local fix for it." So the upstream-report plan (FU2 below) is
superseded by a **local patch** to effect's `aggregateWithin`/`stepToBuffer` via the
repo's existing `patches/effect@4.0.0-beta.78.patch` (pnpm `patchedDependencies`).

**Approach:** minimal, semantics-preserving rewrite of the one leaking function.
Original (installed `dist/Stream.js`):
```js
return step(lastOutput).pipe(
  Effect.flatMap(() => !sinkHasInput ? loop() : Queue.offer(buffer, scheduleStep)),
  Effect.flatMap(() => Effect.never),
  Pull.catchDone(() => Cause.done()));
```
`loop()` recurses while nested inside `flatMap(() => Effect.never)` + `catchDone`, so
every idle schedule tick leaves +2 continuation frames on the fiber `_stack` that are
never popped. Patched:
```js
return step(lastOutput).pipe(
  Pull.catchDone(() => Cause.done()),
  Effect.flatMap(() => !sinkHasInput ? loop() : Queue.offer(buffer, scheduleStep).pipe(Effect.flatMap(() => Effect.never))));
```
`loop()` is now in TAIL position (continuations replace, don't stack); `Effect.never`
wraps only the emit path; `catchDone` scopes to the `step` call. Semantics preserved:
idle → re-step; sink has input → offer a marker then park; schedule expiry → `Cause.done()`.

**Premise validated empirically (Hard Rule 8):** patch installed, then measured on
the patched runtime — idle `groupedWithin(Stream.never, 64, "5ms")` heap went from
+0.18 MB/s to **flat (0.1 MB / 12 s)**; `groupedWithin(3)` over `[1..7]` still yields
`[[1,2,3],[4,5,6],[7]]` (size path); a 40 ms-spaced source with
`groupedWithin(100, "120ms")` still yields non-empty in-order time-based batches
(timer path). Full repo gate green with the patched effect (no consumer broke).

**Risk / tradeoffs:** patching a hot core combinator on a churning beta carries a
re-apply-on-upgrade burden (the patch is keyed to `effect@4.0.0-beta.78`; a bump needs
re-verification). Blast radius is contained: no code in this repo or the installed
effect dist calls `aggregateWithin`/`groupedWithin` transitively (verified), so today
the patch is pure insurance for any future/transitive use. The existing repo pattern
(effect is already locally patched for RpcClient hooks) makes this a well-trodden path.

## FU2 — upstream bug report (external) [SUPERSEDED by FU4 — kept for the repro/draft record]

**Repro built and confirmed.** A minimal standalone script drains
`Stream.groupedWithin(Stream.never, 64, "5 millis")` (idle: the never-emitting
source keeps the schedule ticking with an empty sink) and samples `heapUsed` under
forced GC each second. Result: heap climbs **linearly and GC-survivingly** (+0.18
MB/s ≈ ~630 MB/hr at 5 ms ticks), while the identical `Stream.never` drain *without*
`groupedWithin` is dead flat (0.0 MB). The growth is retained continuation frames,
tracking the timer not the (zero) element rate — the production signature (~1.9
GB/hr at 20 ms ticks × real fiber count). Pinned to
`effect@4.0.0-beta.78 dist/Stream.js:5887-5888` (`stepToBuffer` self-recursing
`loop()` inside `flatMap(() => Effect.never)`).

Draft the effect (effect-smol) issue from this. **Do not post** without
confirmation (outward-facing). Repro script + issue draft captured in the Stage 10
report.

## Order & release

Per Hard Rule 6 and the user's instruction: FU1 branch → sanitize → full verify
gate → squash-merge to trunk (`personal`) with **no release**; FU3 branch off
updated trunk → same drill; FU2 produced (no merge). Then release the accumulated
work. "Release" here = rebuild + restart the launchd server; because that restarts
the freshly-CONFIRMED OOM-fix server (pid 87173, 24 h+ flat) and ends the active
session, the deploy *timing* is surfaced to the user at Stage 9 rather than done
silently — FU3 is dev-tooling (zero runtime effect) and FU1 is a behavior-neutral
cleanup, so there is no urgency forcing an immediate restart.

## Tradeoffs / limitations

- FU1 slightly reduces defensive redundancy (no periodic forced resync). Accepted:
  it defended a non-existent failure mode and cost real churn.
- FU3 is a lexical guard on the `Stream.` namespace prefix; an aliased import
  (`import { groupedWithin } from "effect/Stream"`) would evade it. Accepted: the
  codebase uses the namespace form uniformly (verified); a comment documents the
  limitation. Extending to track import bindings is a possible later hardening.

## Follow-ups deferred

None expected. Any surfaced during sanitize are drained before release (Hard Rule 6).

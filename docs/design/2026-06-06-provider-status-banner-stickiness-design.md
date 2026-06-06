# Provider status banner stickiness — design

**Date:** 2026-06-06
**Branch:** `fix/claude-provider-status-stickiness`

## Problem

User report: a gold/warning banner appeared in the chat view — "UniSub provider
status / Could not verify Claude authentication status from initialization
result." — with no way to dismiss it.

Root cause chain (confirmed by code reading; both Claude instances are
currently `ready`/`authenticated` in `~/.t3/caches`, so the failure was
transient):

1. **Fragile probe.** `probeClaudeCapabilities`
   (`apps/server/src/provider/Layers/ClaudeProvider.ts`) spawns a full Claude
   Code SDK session — which runs the user's SessionStart hooks and MCP/plugin
   init from `~/.claude` — under an 8 s timeout
   (`CAPABILITIES_PROBE_TIMEOUT_MS`). Under machine load (e.g. many concurrent
   agent sessions) the init can exceed 8 s.
2. **Failure pinned in cache.** The probe maps _any_ failure (timeout, spawn
   error) to a successful `undefined` via `Effect.result` + `Effect.map`. The
   per-instance `capabilitiesProbeCache` (`ClaudeDriver.ts`, `Cache.make`,
   TTL = 5 min) stores that `undefined` as a completed lookup. The snapshot
   refresh loop (`refreshInterval` = 5 min) then re-serves the cached miss, so
   the `warning` status persists for up to ~2 refresh cycles per failure — and
   indefinitely if probes keep timing out.
3. **Failure cause swallowed.** No log is emitted, so nothing appears in
   `server.trace.ndjson` to diagnose with.
4. **Non-dismissible UI.** `ProviderStatusBanner`
   (`apps/web/src/components/chat/ProviderStatusBanner.tsx`) renders any
   non-`ready`/`disabled` status as an `Alert` with no dismiss affordance —
   unlike `SidebarProviderUpdatePill`, which supports "Dismiss until provider
   status changes."

## Approach (three-part combination)

### 1. Server — don't pin failed probes (ClaudeDriver.ts)

After `Cache.get(capabilitiesProbeCache, key)` resolves `undefined`,
`Cache.invalidate` the entry so the next status refresh re-probes instead of
re-serving the miss for the full TTL. Successful probes keep the 5-min TTL.
Extracted as a small exported helper so it is unit-testable with a counting
lookup.

### 2. Server — observability + headroom (ClaudeProvider.ts)

- Log the probe failure at warning level, distinguishing timeout from error
  cause, instead of silently mapping to `undefined`.
- Bump `CAPABILITIES_PROBE_TIMEOUT_MS` 8 000 → 15 000. The probe runs on a
  background refresh fiber; a longer timeout only delays detection of a
  genuinely hung CLI, while materially reducing spurious timeouts under load.

### 3. Web — dismissible banner (ProviderStatusBanner.tsx)

Add a dismiss (X) button using the existing `AlertAction` slot. Dismissal key:
`instanceId|status|message` — the banner stays hidden while the status is
unchanged and reappears when the status/message changes (including
recovering → degrading again). State lives in a module-level zustand store,
session-scoped (NOT persisted): statuses re-check every 5 min, and persisting
dismissals could permanently hide a genuine auth problem.

## Alternatives rejected

- **Treat probe failure as non-degrading (keep `ready`).** Wrong: auth state
  is genuinely unknown; could mask a real logged-out CLI.
- **Fall back to last-known-good auth from `providerStatusCache`.** More
  moving parts; risks showing a stale "authenticated" after a real logout.
- **Only bump the timeout.** Doesn't fix the 5-min failure pinning, the
  swallowed diagnostics, or the dismissability gap.
- **Persist dismissals to localStorage.** Could hide real auth issues forever;
  session scope matches the sidebar pill precedent.

## Files touched

- `apps/server/src/provider/Drivers/ClaudeDriver.ts` — invalidate-on-undefined
  helper + use.
- `apps/server/src/provider/Layers/ClaudeProvider.ts` — failure logging,
  timeout bump.
- `apps/web/src/components/chat/ProviderStatusBanner.tsx` — dismiss button +
  session-scoped dismissal store.
- New tests: driver cache behavior; banner dismissal-key logic.

## Tradeoffs / limitations

- A _persistently_ failing probe now re-probes every refresh (one extra
  subprocess spawn per 5 min) — negligible.
- Dismissals reset on app reload (by design).
- Codex/Cursor/OpenCode providers may have analogous probe-stickiness
  patterns; out of scope here (follow-up).

## Design review notes (1 round, quiesced)

- **Invalidate race:** implemented as a single Effect chain on the `Cache.get`
  result. Residual race (a concurrent refresh caches a fresh success that we
  then invalidate) costs at most one extra re-probe on the next refresh —
  accepted as benign.
- **Dismissal key churn (rejected):** version-upgrade text only attaches to
  `ready` statuses, which never render the banner. Keying on `checkedAt` was
  rejected as it churns every refresh and would resurface dismissed banners.
  A changed warning/error message intentionally resurfaces the banner.
- **Store choice:** module-level zustand store over `useState` because the
  banner can remount on thread switch; useState would resurface dismissed
  banners on every switch. Keys are per-instance, so no cross-instance hiding.
- **Dismiss UX:** instant hide (inline alert; the sidebar pill's exit
  animation is pill-list-specific).
- **Logging:** timeout and error failures logged with distinct messages.

## Follow-ups deferred

- Audit Codex/Cursor/OpenCode drivers for the same cached-failure pattern.

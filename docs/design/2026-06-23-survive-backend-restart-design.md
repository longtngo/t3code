# Surviving a backend restart mid-agent-turn — 2026-06-23

## Goal

When `t3-rebuild` restarts `com.t3code.server` (`launchctl kickstart -k`, a SIGKILL),
any in-flight agent turn is orphaned: no terminal event is written, and the thread's
session stays `status:"running"` forever (until `ProviderTurnStallWatchdog` trips at
15 min). The client reconnects fine; only the turn/session record is stuck.

Three improvements, each independent:

- **A** — make the `rebuild-t3code` skill *fire-and-return*: launch the detached
  coordinator and end the turn immediately, so the turn's terminal event is written
  *before* the restart. The drop then lands on an idle session → clean reconnect.
- **C** — durable t3code fix: on boot, reconcile any thread whose session is still in a
  *live* status (a crash/restart artifact) → mark it stopped + interrupt its active turn,
  immediately, instead of waiting 15 min.
- **B** — auto-continue: after the coordinator's health check is green, re-prompt the
  originating thread to continue, so work resumes hands-free.

## Verified premises (Hard Rule 8)

- Spinner derivation: `apps/web/src/components/Sidebar.logic.ts:406` — `thread.session?.status === "running"` ⇒ "Working" spinner (secondary: `hasPendingBackgroundTask`). **Turn state does not drive the spinner.**
- Session status only changes via the `thread.session-set` event (`ProjectionPipeline.ts:969`). `thread.turn.interrupt` only sets `projection_turns.state="interrupted"` (`ProjectionPipeline.ts:1125`) — necessary for history, **insufficient** to clear the spinner.
- Clean terminal session shape (what the reactor's stop produces): `status:"stopped", activeTurnId:null`, preserving providerName/instanceId/runtimeMode/lastError (`ProviderCommandReactor.ts:1012-1027`).
- Command dispatch applies the projection **synchronously** inside the engine SQL transaction (`OrchestrationEngine.ts:175-212`, `projectionPipeline.projectEvent` at :184) — so a boot phase that dispatches `thread.session.set` + `thread.turn.interrupt` updates the projection deterministically with **no reactor running and no process-kill attempt** on a dead PID.
- Boot id: minted fresh per process (`RuntimeBootId.ts`), not persisted standalone. **Not needed for C**: at the boot reconciliation point (before reactors start) the fresh process owns zero sessions, so *any* thread still in a live session status is necessarily orphaned from the previous process. (This is strictly simpler and safer than a boot_id comparison and matches the `BackgroundTaskRecoveryWatchdog` "prior-boot" intent.)
- B transport: no HTTP send-message endpoint; `orchestration.dispatchCommand` is WS-RPC only, requires a bearer token + the Effect RPC wire protocol. `t3 auth session issue --token-only` exists (`cli/auth.ts:79,162`). `packages/client-runtime` (`wsRpcClient.ts`/`wsTransport.ts`/`wsRpcProtocol.ts`) uses `globalThis.WebSocket` with no DOM deps ⇒ usable from a Node CLI. ⇒ B is feasible as a CLI subcommand, NOT a bash/curl one-liner.

## Approach

### A — rebuild-t3code fire-and-return (skill docs only)
Rewrite the skill's "Run it" steps so the agent: pre-flight → launch detached coordinator →
**immediately end the turn** with a short note ("rebuild running detached; this session will
drop when the BE restarts; reconnect after"). Remove any instruction to poll/monitor/`tail`
the coordinator within the same turn. Verification moves to the *next* turn after reconnect.
This is the single highest-value change: it prevents the stuck-turn entirely.

### C — boot turn/session reconciliation (t3code server)
New one-shot startup phase `turns.reconcile`, wired in `serverRuntimeStartup.ts` immediately
**before** `reactors.start`, gated by `T3CODE_BOOT_RECONCILE` (set to `0` to disable),
mirroring the `T3CODE_TURN_STALL_WATCHDOG`/`T3CODE_BG_TASK_RECOVERY` flags.

Logic (a new `BootTurnReconciler` layer, mirroring the shape of the watchdogs):
1. Enumerate threads whose `session.status ∈ {idle,starting,running,ready}` via the projection snapshot query.
2. For each, dispatch `thread.session.set` with the reactor's clean terminal shape (`status:"stopped", activeTurnId:null`, preserved provider fields).
3. If that session had an `activeTurnId`, also dispatch `thread.turn.interrupt {threadId,turnId}` so the turn's history reads `interrupted`, not a dangling `running`.
4. `Effect.logInfo("boot.turns-reconciled", { count })`.

Reuses existing commands only; no new events/migrations. Synchronous, so the spinner is
cleared before the UI ever reconnects. Runs before reactors so there's no race with a
freshly-starting session and no attempt to kill a non-existent provider process.

### B — `t3 thread resume` CLI + coordinator auto-continue
- New CLI subcommand `t3 thread resume --thread <id> --message <text> [--port N]`: issues a
  short-lived scoped session token in-process (same `environmentAuth.issueSession` path as
  `t3 auth session issue`), connects to the running server over loopback WS using
  `@t3tools/client-runtime`, dispatches `thread.turn.start` with a user message, and exits.
- Skill/coordinator wiring: the agent records the originating `ThreadId` before launching the
  coordinator (passed via env `RESUME_THREAD_ID`). After the health check is green, the
  coordinator runs `node dist/bin.mjs thread resume --thread "$RESUME_THREAD_ID" --message
  "Backend rebuilt and healthy — continue."`. t3code resumes the provider session via its
  continuation `groupKey`, so the agent picks up with full context.
- **Descope condition (per the task's explicit gate):** if the CLI cannot be made to drive the
  WS client from Node without interactive auth or browser-only deps, ship A+C and hand B back
  as a designed follow-up rather than forcing a fragile path.

## Alternatives rejected
- *Loopback-only unauthenticated HTTP "resume" endpoint* (for B): rejected — the server is
  exposed to the tailnet via `tailscale serve`, which proxies from loopback, so a naive
  loopback-peer waiver would expose a turn-starting command endpoint to the whole tailnet.
  Token-authed CLI keeps the existing auth model.
- *boot_id comparison for C*: unnecessary — "fresh process owns zero sessions" makes every
  live-status session at boot definitionally orphaned. Simpler, no persistence needed.
- *Dispatch `thread.session.stop` (reactor path) for C*: rejected as the primary mechanism —
  it's async (worker queue), depends on reactor ordering, and calls `providerService.stopSession`
  (a dead-PID signal). Direct synchronous `thread.session.set` is deterministic and reactor-free.

## Files touched
- A: `~/.claude-personal/skills/rebuild-t3code/SKILL.md` (+ mirror in `~/src/personal/agent-skills/...`); `scripts/coordinated-rebuild.sh` for B's resume hook.
- C: `apps/server/src/orchestration/Layers/BootTurnReconciler.ts` (new) + test; wiring in `serverRuntimeStartup.ts`; layer provision in `server.ts`.
- B: `apps/server/src/cli/thread.ts` (new) + `bin.ts` subcommand registration; coordinator script.

## Tradeoffs / limitations
- C clears the indicator and turn history but does not *resume* the interrupted work — that's B's job (and A makes it moot for rebuilds by ending the turn cleanly first).
- B starts a brand-new turn (continuation-resumed) rather than truly resuming the killed turn — the only thing possible after a SIGKILL.

## Follow-ups deferred
- None expected; any surfaced during sanitize get drained per Hard Rule 6.

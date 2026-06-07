# Claude Agent SDK — known issues & version floor

Developer notes on `@anthropic-ai/claude-agent-sdk` quirks t3code works around, and why the
dependency is floored. User-facing Claude setup lives in [`claude.md`](./claude.md).

## Version floor: `>= 0.3.159`

`apps/server/package.json` floors `@anthropic-ai/claude-agent-sdk` at `^0.3.159`. Two reasons:

1. **Reliable background-task resume.** `0.3.159` emits a structured `task_notification{status:"failed"}`
   on abnormal background-task exits (non-zero exit and `kill -9`). Earlier builds could settle a
   background task without any notification, so the thread never woke. t3code's wake path
   (`maybeWakeThreadForCompletedTask` in `ProviderRuntimeIngestion.ts`) depends on that event.
2. **A known baseline for the stall below.** The parallel-subagent stall was observed *on* `0.3.159`,
   so the floor is the version we have characterised — not a version that fixes the stall.

When bumping the SDK, re-validate both behaviours (see the checklist).

## Known issue: parallel-subagent turn stall

**Symptom.** When the agent runs two or more subagents in parallel via the `Agent`/Task tool
(`collab_agent_tool_call`), the SDK can accept every subagent's result (`task_notification` +
`claude/user` tool-result injection into the parent turn) and then **never issue the follow-up
inference and never close the turn**. The SDK process simply goes silent. Observed once for ~6h51m
on session `c3de47dc…`; both reviewer subagents had `status:"completed"` and no `turn.completed`
ever followed.

**Why it strands t3code.** The thread keeps an active turn, so neither safety net recovers it:
`maybeWakeThreadForCompletedTask` only wakes idle/turn-less threads, and `ProviderSessionReaper`
skips any session with `activeTurnId != null`. Only a manual user message recovered it.

**Mitigation (t3code-side).** `ProviderTurnStallWatchdog`
(`apps/server/src/provider/Layers/ProviderTurnStallWatchdog.ts`) detects an active turn that has
emitted no SDK events past a threshold (default 15m) and forcefully recovers it (stop session →
resume). It is a defensive workaround, not a fix for the upstream cause. See the design doc
`docs/design/2026-06-07-active-turn-stall-watchdog-design.md` and the RCA
(`~/reports/t3code/2026-06/2026-06-07-parallel-subagent-turn-hang-rca.md`).

**Upstream.** The root cause is in the SDK's parallel-`collab_agent_tool_call` continuation path.
If/when a fixed SDK ships, bump the floor and confirm the stall no longer reproduces; the watchdog
can stay as a generic safety net regardless.

## Checklist when bumping the SDK

- [ ] Background-task resume still fires: abnormal exits (non-zero and `kill -9`) emit
      `task_notification{status:"failed"}` → thread wakes.
- [ ] Parallel-subagent fan-out (≥2 `Agent`/Task tools at once) continues the parent turn after both
      results return — i.e. the stall above does not reproduce.
- [ ] `ProviderTurnStallWatchdog` tests still pass and the watchdog still recognises the recovery
      commands (`thread.session.stop`, `thread.turn.start`).

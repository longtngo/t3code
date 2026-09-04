# Subagent offload: tell the agent, and stop blocking the toggle — 2026-09-04

## Goal

Make the subagent-backend toggle actually change where subagents run, and make the toggle UI
confirm a save promptly.

Two defects, one feature, one branch each concern is scoped below.

## Root cause

**Symptom A — the toggle never reaches the agent.** The state layer is correct end to end. The
global flag file, every live thread's per-thread file, and each Claude subprocess's
`SUBAGENT_BACKEND_STATE` all resolved to Cursor. The wrapper works when invoked. But Claude
Code's native `Agent` tool never consults the flag file, and T3 Code injects no instruction
telling the agent to use `~/bin/subagent-dispatch` — `RuntimeInstructions.ts:12` mentions only
harness and model. The only bridge was the developer's own `CLAUDE.md`, which the design already
flagged as a follow-up:

> `~/bin/subagent-dispatch` is invoked only because a `CLAUDE.md` instruction says so … Rests on
> one developer's dotfiles; follow-up.
> — `docs/design/2026-09-03-thread-subagent-offload-design.md:228`

Measured on the live install: **16 native `Agent` dispatches after the toggle flip**, across
three threads that all had `"backend":"cursor"` flag files at the time, and **zero** Cursor
dispatches in the same window.

**Symptom B — the toggle UI lags.** `subagentBackend.set` (`ws.ts:2296-2307`) writes the flag
file and then blocks on a Cursor `--list-models` probe before responding, and
`useSubagentBackend` commits state only from a resolved response. The row shows a spinner beside
the _pre-save_ label for the whole round trip, which reads as a failed save.

An independent RCA blamed stale per-thread files instead. That gap is real but is not what was
hit: all four stale `"default"` files belong to threads with no activity since before the flip.
Carried as a follow-up, not fixed here.

## Baseline

```
Baseline @ b41926577 (2026-09-04)

  wrapper share (real population): 0 / 16 = 0.000
    query: projection_thread_activities, kind='tool.started',
           summary LIKE '%Subagent%', created_at > '2026-09-04T15:10:18Z'
    → 16 rows, all toolName="Agent", in threads 40a4d356 / 4c73f3c6 / 01cfc253,
      each with a "cursor" per-thread flag file at dispatch time
    cross-check: ~/.cursor/chats newest entry before the manual probe = Aug 30 22:02

  subagentBackend.set critical path: `agent --list-models`
    idle machine:   667-907 ms   (5 runs, p50 681 ms)
    loaded machine: 3057-11702 ms (5 runs, p50 3782 ms) - measured by the simplicity
      reviewer while four agents were running, which is the state a developer is
      actually in when they flip this toggle
    codebase records ~3.4 s from an earlier measurement (cursorModels.ts:92), which
      the loaded number corroborates and the idle number does not

  regression floor: pnpm verify green; terminal sessions that read the global file
    directly must keep working
```

## Experiments

Pre-registration: `/tmp/exp-subagent-routing/preregistration.md`, written before any trial.

**Metric M** = wrapper share = wrapper dispatches / all subagent dispatches, from `stream-json`
`tool_use` blocks. **Guardrails:** G1 task completed, G2 no hard failure, G3 the work still gets
done when the wrapper refuses. N = 8 per arm, serial, identical prompt / cwd / env / model
(`claude-opus-5`), Cursor side stubbed.

| Arm                 | Enforcement                       | dispatches | wrapper | native | **M**     | G1  | G2  |
| ------------------- | --------------------------------- | ---------- | ------- | ------ | --------- | --- | --- |
| A0 control          | `CLAUDE.md` only (today)          | 16         | 2       | 14     | **0.125** | 8/8 | 8/8 |
| A1 injection        | + system-prompt instruction       | 16         | 16      | 0      | **1.000** | 8/8 | 8/8 |
| A2 injection + gate | + `--disallowed-tools Agent Task` | 16         | 16      | 0      | **1.000** | 8/8 | 8/8 |

Harness validity: A0 scored 0.125 against a real-world 0.000 — same regime, so the comparison
holds.

**G3 fallback probe** (wrapper refuses, backend `default`, N = 4 per arm):

| Arm | wrapper attempts | refused | native fallback  | G1  |
| --- | ---------------- | ------- | ---------------- | --- |
| A1  | 8                | 6       | 8                | 4/4 |
| A2  | 8                | 8       | 0 (tool removed) | 4/4 |

A1 degrades exactly as the wrapper's exit-3 contract intends: it tries the wrapper, is refused,
and falls back to a Claude subagent. A2 completes the work too, but by dropping subagents
entirely — offload unavailable silently becomes no parallelism.

**Decision, by the pre-registered rule (step 1):** A1 reaches M ≥ 0.90 with all guardrails
intact → **adopt A1.** A2 is rejected: identical M, no measured lift, strictly worse degradation,
and it removes a tool the user may want for other reasons.

### Re-measurement of the shipped text

The text changed twice after A1 was measured, so A1's number no longer described what would ship.
Both round 2 reviewers caught this independently and neither could re-measure it — their sandbox
denied Bash its temp directory, so their runs scored M = 0.000 on a confound and they said so
rather than reporting it as a result. Re-run here, N = 8, final text, everything else identical:

| Arm | Text                | dispatches | wrapper | native | **M**     | G1  | G2  |
| --- | ------------------- | ---------- | ------- | ------ | --------- | --- | --- |
| A1  | round 1 wording     | 16         | 16      | 0      | **1.000** | 8/8 | 8/8 |
| A1b | **shipped wording** | 16         | 16      | 0      | **1.000** | 8/8 | 8/8 |

G3 re-run on the shipped text (wrapper refuses, N = 4): 8 wrapper attempts, 8 native fallbacks,
4/4 completed — the same degradation shape that separated A1 from A2 in the first place. The
guardrail that decided the arm was re-checked against the wording that changed it.

### A confound found afterwards, and the cleaner number

Every arm above ran with `--setting-sources user,project,local`, matching production
(`CLAUDE_SETTING_SOURCES`). That pulled in a personal `CLAUDE.md` on this machine which already
tells the agent to use the wrapper. Building the committed harness exposed it: a **deliberately
neutered** instruction that mentions offload but never names `subagent-dispatch` still scored
M = 1.000 under those sources. The harness could not fail, which made it worthless as a gate.

The comparison above survives — A0 carried the same `CLAUDE.md` and still scored 0.125 against a
real-world 0.000 — but the A1 = 1.000 figure was over-attributed to the instruction. Re-measured
with `user` dropped, so the instruction is the only thing that can steer:

| Instruction                       | dispatches | wrapper | native | **M**     |
| --------------------------------- | ---------- | ------- | ------ | --------- |
| Neutered, never names the wrapper | 6          | 0       | 6      | **0.000** |
| Shipped                           | 8          | 8       | 0      | **1.000** |

That is stronger evidence for the shipped decision than the original run, and it is the
configuration the committed harness uses.

## Approach

### 1. Inject the dispatch instruction (Claude only)

At the single consumption site that already builds the per-thread env
(`ClaudeAdapter.ts:5018-5022` / `:5050-5057`), read the per-thread flag file that
`ProviderService` wrote immediately before `startSession` and, when it resolves to Cursor, append
one instruction to the session's system prompt beside `buildRuntimeInstructions`.

Reuses the existing reader `readThreadBackendFile` (`SubagentBackend.ts:404`) rather than adding
a second parser; its doc comment saying production never reads a thread file stops being true and
moves with it. `FileSystem` and `ServerConfig` are already bound in the adapter's scope
(`ClaudeAdapter.ts:2083-2085`), so the read needs no new service.

The instruction text is a `const` at that one consumption site, **not** in
`RuntimeInstructions.ts`. That module is imported by the Cursor, Codex, Grok and OpenCode
adapters, none of which should ever receive dispatch text; putting a Claude-only string there
spreads it across five adapters to save nothing.

The instruction mirrors the wrapper's own contract, including the exit-3 fallback, so a refusal
still lands on a Claude subagent:

> Subagent offload is ON for this thread. When you need a subagent, do NOT use the Agent tool:
> write the subagent prompt to a file and run `~/bin/subagent-dispatch <short-name> <prompt-file>`
> with the Bash tool. Exit code 3 means offload is unavailable for this thread — only then fall
> back to the Agent tool. Any other non-zero exit is not a fallback signal: read stderr, then
> either fix your invocation or treat it as a failed subagent run.

**Exit 3 is the only fallback signal, and the instruction says so in one clause rather than
enumerating codes.** Two earlier drafts got this wrong in opposite directions. The first said any
non-zero exit meant offload was unavailable, which would send the agent to a Claude subagent after
its own malformed invocation. The second enumerated 64 / 65 / 66 as "fix the invocation" — but the
wrapper `exec`s the target (`subagent-dispatch:84,92`), so the target's own exit code propagates:
a Cursor run that fails gives 1, and a missing `cursor-scratch` gives 127. Both would have been
read as "you typed it wrong". Naming only exit 3 and pointing at stderr for everything else is
both shorter and the only version that is correct for codes the wrapper does not generate itself.

A span attribute — not a new log event — records the outcome. `ClaudeAdapter` already annotates
session start with `provider.thread_id` and a block of `claude.query.*` keys
(`ClaudeAdapter.ts:5077-5101`); this adds one key there rather than inventing a second
observability surface at the same point. It is set on **every** Claude session start, `false`
included, so absence means "no session start" rather than "offload was off" — the distinction the
incident that produced this task actually needed.

Claude only, matching the existing enforcement surface: Codex, Grok and OpenCode read `AGENTS.md`
and never receive `SUBAGENT_BACKEND_STATE`, and materializing their environment has side effects
the prior design already ruled out (`2026-09-03-thread-subagent-offload-design.md:226-233`).

### 2. Take the model probe off the `set` critical path

One argument. `ws.ts:2303-2305` currently passes `settings.subagentBackendEnabled !== false` as
`refresh`, so with the master switch on — the default — every `set` spawns `agent --list-models`
and the RPC waits for it. Passing `false` returns the models already cached
(`peekCursorModels`), matching what `subagentBackendGet` does on mount. The response stays authoritative — the flag-file write has
already completed — it just stops waiting on a subprocess. The picker's own list comes from the
provider snapshot; the probe survives as the fallback a panel-open `get(refreshModels: true)`
still runs.

No optimistic flip. `useSubagentBackend` is unchanged: the reason its module doc gives for
committing only from resolved responses is still sound, and the fix removes the wait rather than
lying about it.

## Alternatives rejected

- **A2, hard-gate the `Agent` tool.** Measured: no lift over A1, and worse degradation. Rejected
  by the pre-registered decision rule, not by taste.
- **Restart running provider sessions when the resolved backend changes.** Would apply the
  instruction to in-flight threads, but kills work the user asked to be left running. Explicitly
  out.
- **Inject into every provider.** Governs nothing (they read `AGENTS.md`), and materializing
  Grok's environment changes its auth method.
- **Optimistic UI flip for symptom B.** Treats the symptom; the RPC is still slow for every other
  caller, and an optimistic flip can show a save that failed.

## What offload actually transfers

Successful offload does not just change which quota pays. It moves agentic side effects out of
Claude Code's `Agent` tool and into a separate Cursor process that `~/bin/subagent-dispatch`
launches with `-p --trust --force` — a different permission model, a different working directory
(`~/bin/cursor-scratch` seeds one per dispatch), and a different tool set. Containment comes from
the `sandbox.sb` profile that `cursor-scratch` seeds and the wrapper `exec`s under.

That containment can disappear silently-ish: with no profile in the scratch dir, or on a host
without `sandbox-exec`, the wrapper prints `dispatching UNSANDBOXED` to stderr and dispatches
anyway (`subagent-dispatch:86-92`). The degradation is deliberate and pre-existing, but this
change is what makes it routinely reached — measured wrapper share goes from 0.125 to 1.000 — so
it is named here rather than left implied.

## Known limitation

A system prompt is frozen for a session's lifetime. Flipping the toggle mid-thread updates the
flag file immediately — so a running agent that _does_ consult the wrapper is routed correctly —
but the **instruction** only reaches that thread at its next session start. This is deliberate:
the alternative is restarting live sessions, which the user ruled out. Same self-healing shape as
the flag file itself.

## Test plan

The decisive behavior — a model choosing one tool over another — is not unit-testable, and the
honest substitute is named rather than faked:

| #   | Test                                                             | Layer                      | Catches                                        |
| --- | ---------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| 1   | `subagentDispatchAppend(backend)` returns the block for `cursor` | pure fn in `ClaudeAdapter` | injection missing                              |
| 2   | the same returns `""` for `default`, malformed, and absent       | pure fn                    | injection leaking when offload is off          |
| 3   | `subagentBackend.set` resolves without spawning `--list-models`  | the RPC handler in `ws.ts` | the probe creeping back onto the critical path |

Tests 1 and 2 assert on a small pure function and match a **fragment** (`subagent-dispatch`), not
the full prose, so rewording the instruction does not turn into a failing test — `AGENTS.md`
warns against tests that mirror the implementation, and a prose-equality assertion is exactly
that. Test 3 must sit at `ws.ts`, not at `modelsForPersistedBackend`: the regression site is the
argument `ws.ts` passes, and re-testing the function it passes to would be a tripwire pointed at
the wrong wire.

**Test 3 was written by removing the thing it would have had to test.** The RPC body moved out of
`ws.ts` into `SubagentBackend.setBackendState`, so there is no longer a `refresh` boolean at the
RPC boundary for anyone to get wrong, and the existing `listCursorModels` mock — which dies if it
runs — now reaches the real call site. Through `ws.ts` it could not, and building the ws-level
harness to reach it would have cost more than the assertion was worth.

**Routing itself stays on the out-of-band harness**, now committed at
`scripts/subagent-routing-harness/` rather than living in `/tmp` where the one gate this feature
has would have been deleted. It reads the instruction out of `ClaudeAdapter.ts` instead of
carrying a copy — a copy is what drifted twice during this run. N = 8, decision
threshold M ≥ 0.90. Re-run it whenever the instruction text changes — this run had to, twice, and
the second time caught that the shipped text was no longer the measured text. A green
`pnpm verify` says nothing about whether the model still follows the instruction. That is a proxy
boundary, not a coverage gap to paper over.

## Files touched

- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — read the thread flag file, append the
  instruction
- `apps/server/src/subagentBackend/SubagentBackend.ts` — doc comment on `readThreadBackendFile`
- `apps/server/src/ws.ts` — one argument: `refresh` on `set` becomes `false`
- `apps/server/src/subagentBackend/SubagentBackend.set.test.ts` — the comment saying "ws always
  calls with true" goes stale with that change
- `apps/server/src/subagentBackend/SubagentBackend.ts` — `modelsForPersistedBackend`'s doc comment
  says `refresh: true` is what `set` uses; same lie, two files apart

## Follow-ups deferred

- **Stale per-thread files — premise falsified, not built.** The worry was that
  `reconcileThreadBackendsBody` swallows adapter enumeration failures. It does, but that path is
  unreachable: `listSessions()` is `Effect.sync` on Claude, Cursor, Grok, OpenCode and
  Antigravity, and Codex's composes `CodexSessionRuntime.getSession`, typed
  `Effect.Effect<ProviderSession>` — error channel `never`. No adapter's `listSessions` can fail.
  What remains is `getByInstance` failing for an instance deleted between `listInstances()` and
  the lookup, whose sessions are being torn down anyway. Threads with no live session are covered
  by `writeThreadBackendForSession` at their next session start, on both `ProviderService` paths.
- **Instruction/wrapper contract sync — closed by the harness.** The wrapper lives in a separate
  repository (`~/src/personal/subagent-dispatch`, symlinked into `~/bin`), so no test in this repo
  can import it. It does not need to: `scripts/subagent-routing-harness/run.sh --fallback` drives
  the **real** wrapper — only the Cursor binary behind it is stubbed — with a `default` flag file,
  so the refusal path is exercised end to end. If the wrapper's refuse code stopped being 3, the
  instruction's "any other non-zero is not a fallback signal" clause would keep the agent from
  falling back and the harness's completion gate would fail. The in-repo half is covered by the
  `names exit 3 as the only fallback signal` unit test.

All follow-ups from this design are now closed. Two shipped, one was falsified rather than built,
one turned out to be covered by the harness.

## Review exit note

**Round 1** — pillar sweep (`review-technical-design`, embedded) in parallel with three lenses:
correctness, simplicity, and security+privacy batched with observability+operability. Every
reviewer was told to build and run rather than read, and all four did: they prototyped the
injection against fixture flag files, exercised the wrapper's exit codes, and re-scored the
experiment harness.

**Pillar verdict: CONDITIONAL GO.** No Critical or High findings from correctness or security.

Applied:

- Instruction now distinguishes exit 3 (offload unavailable, fall back) from 64/65/66 (bad
  invocation, fix and retry). The reviewer ran the wrapper and read the codes off it; the earlier
  "any non-zero" wording would have sent the agent to a Claude subagent after its own mistake.
- Dropped the `RuntimeInstructions.ts` touch — a Claude-only string in a module four other
  adapters import, to save nothing.
- `ws.ts` fix restated as the one argument it actually is, plus the stale test comment it makes
  wrong.
- Added the test plan, and said plainly that routing is not unit-testable and stays on the
  out-of-band harness.
- Added "What offload actually transfers": the design was silent on the execution boundary moving
  into a `--trust --force` Cursor process whose sandbox can degrade to UNSANDBOXED.
- Added one structured log line so "is offload on for this thread" stops being a SQL query.
- Baseline now carries the loaded-machine probe number (p50 3782 ms), which is the state a
  developer is in when they flip the toggle. My idle-machine 681 ms understated symptom B by ~5x.

Rejected, with reasons:

- **Gate injection on `degraded` as well as `backend`** (security F8). A degraded-but-cursor file
  can still dispatch, and the wrapper's exit-3 path already covers the case where it cannot.
  Adding a second condition buys a cosmetic agreement between the sidebar badge and the
  instruction at the cost of a branch.
- **Shorten the instruction** (simplicity F2). The reviewer's short arms all scored M=0.000 — but
  so did their replication of the long arm, on an `EPERM` that made Bash unusable in their
  sandbox. That is a confounded measurement, not evidence, and they said so. Undetermined;
  keeping the measured text.
- **Pass the resolved record down from `ProviderService`** instead of re-reading the file
  (simplicity F1). The reviewer counted it: ~26 lines across 5+ files and a contract change,
  versus ~20 across 3 with no contract change. The read is redundant I/O and still the smaller
  diff.

**Round 2** — correctness, and simplicity batched with observability, re-dispatched against the
edited design and told to report new findings only. Both returned new findings, so round 1 was
not the exit.

Applied:

- **The round 1 exit-code fix was itself wrong** (correctness, High). Enumerating 64/65/66 as
  "fix the invocation" ignores that the wrapper `exec`s the target, so a failed Cursor run
  propagates rc=1 and a missing `cursor-scratch` gives rc=127 — both would have been read as a
  typo. The reviewer ran each case. Rewritten to name only exit 3 and point at stderr for
  everything else, which is simultaneously the correctness fix and the shorter text the
  simplicity lens asked for (~26 tokens per session back).
- **Re-measured the shipped text** (both lenses, independently). The measured wording was no
  longer the shipping wording. A1b: M = 1.000 over N = 8, plus the G3 guardrail re-run at 4/4.
  Neither reviewer could run this themselves — Bash `EPERM` in their sandbox — and both correctly
  marked it UNDETERMINED instead of reporting the confounded zero.
- **Span attribute, not a new log event** (observability). `ClaudeAdapter.ts:5077-5101` already
  annotates session start with `claude.query.*` keys; a second surface at the same point was
  invention. Set on every session start including `false`, so absence means "no session start".
- **Test 3 moved to the `ws.ts` layer.** Pointing it at `modelsForPersistedBackend` would have
  tested the function receiving the argument rather than the site passing it — a tripwire on the
  wrong wire. Tests 1-2 narrowed to a fragment match on a small pure function, per `AGENTS.md`'s
  warning about tests that mirror implementation shape.
- Second stale comment (`SubagentBackend.ts:611`) added to files touched.
- Cut the "enforcement stays advisory" paragraph — it restated _Alternatives rejected_.

**Exit:** two rounds. Round 2's findings were new, not repeats, which is why round 1 was not the
exit; every one of them is applied above. The one open item both rounds raised — whether the
shipped instruction still routes — was closed by measurement rather than by argument, which is
the only way it could have been closed. No lens was dropped for budget.

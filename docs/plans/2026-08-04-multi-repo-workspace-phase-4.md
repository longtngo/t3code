# Multi-repo workspace — Phase 4: checkpoint integrity

Implements the *Checkpoint integrity* section of
`docs/design/2026-08-04-multi-repo-workspace-design.md`.

**Goal:** a revert either restores the whole tree or says precisely which repositories
it cannot restore. It never quietly restores staging while leaving member repositories
changed.

Checkpoints stay staging-only. Dropping cross-repo capture does not drop the hazard, so
completeness becomes a function of what the turn actually touched rather than of whether
the project is a workspace.

## Premises, validated before designing

| Premise | Probe | Result |
|---|---|---|
| The revert path can see the checkpoint summaries | read `CheckpointReactor.ts:740-745` | true — it already looks a checkpoint up in `thread.checkpoints` by turn count |
| There is a mechanism for refusing a revert with a reason | `appendRevertFailureActivity` at the same site | true — used for both "ref unavailable" and "checkpoint unavailable" |
| Capture and revert are in the same reactor as the member sweep | `CheckpointReactor.ts` capture ~`:253`, revert ~`:757` | true — no new wiring, and Phase 3's sweep already reads each member |

## Model

```ts
// OrchestrationCheckpointSummary, packages/contracts/src/orchestration.ts
memberStates: Schema.optional(
  Schema.Array(
    Schema.Struct({
      memberId: TrimmedNonEmptyString,
      headSha: TrimmedNonEmptyString,
      isDirty: Schema.Boolean,
    }),
  ),
),
```

`optional` rather than defaulted, deliberately: a checkpoint captured before this
shipped is then distinguishable from one captured with no members. The former cannot
make a completeness claim at all and is treated as complete, which is exactly today's
behavior; the latter claims completeness truthfully.

## Tasks

1. **Contract** — add `memberStates`; assert both skew directions decode.
2. **Capture** — record one `{ memberId, headSha, isDirty }` per member alongside the
   staging capture. No snapshot and no objects written: one `git rev-parse HEAD` plus
   the dirty flag the sweep already reads.
3. **Compare** — a pure `resolveCheckpointDrift(recorded, current)` returning the
   member ids whose head moved or whose dirty flag changed. Pure so the decision is
   testable without git.
4. **Revert** — no drift, revert normally with no warning and no degradation (the
   common case for staging-only turns). Drift, refuse and name the repositories.

## Testing

- Capture with members clean, then revert → proceeds.
- Capture, then dirty a member → revert refuses and names that member.
- Capture, then move a member's `HEAD` → revert refuses and names it.
- A summary with no `memberStates` at all → revert proceeds, matching pre-Phase-4
  behavior.
- A summary with an empty `memberStates` array → treated as a real claim, not as
  "unknown".

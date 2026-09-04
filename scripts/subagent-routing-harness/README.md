# Subagent routing harness

Answers one question: **does the shipped dispatch instruction still make the agent route subagents
through `~/bin/subagent-dispatch` instead of Claude Code's native `Agent` tool?**

Nothing in `pnpm verify` can answer it. The behaviour under test is a model's tool choice, not a
code path, so the repo's tests cover the wiring (is the instruction appended for a `cursor` thread,
and absent otherwise) and this covers the effect. That split is deliberate — see
`docs/design/2026-09-04-subagent-dispatch-instruction-design.md`.

## When to run it

**Whenever the instruction text changes.** That is the whole reason this exists. During the
original work the text was edited twice after it was measured, and both times the number on record
described wording that was no longer shipping.

## Running it

```sh
./run.sh              # 8 trials, offload ON, passes at M >= 0.90
./run.sh -n 4         # fewer trials
./run.sh --fallback   # offload UNAVAILABLE: the wrapper refuses; the model must fall back
                      # to the Agent tool and still finish
```

It spends real Claude tokens — one short session per trial, run serially. Cursor is stubbed, so it
costs nothing on that side. Trials are serial on purpose: they share one rate-limited backend, and
running them in parallel measures the rate limiter rather than the instruction.

**It runs with `--setting-sources project,local`, deliberately without `user`**, even though
production passes `user` as well. A personal `CLAUDE.md` that already tells the agent to use the
wrapper steers it by itself: with `user` enabled, a deliberately neutered instruction that never
names `subagent-dispatch` still scored M = 1.000 here. A harness that cannot fail is worthless, so
`user` is dropped and the shipped instruction is left as the only signal — which is also the
situation of any user who does not happen to have that rule in their dotfiles.

## What it measures

**M = wrapper dispatches / all subagent dispatches**, pooled across trials, read out of each run's
`stream-json` `tool_use` blocks. A dispatch counts only when the wrapper _leads a command segment_
— `ls ~/bin/subagent-dispatch` is the model inspecting the harness, and counting those inflated an
early run.

Reference numbers from the original pre-registered experiment, 8 trials per arm on
`claude-opus-5`:

| Arm                                        | M     |
| ------------------------------------------ | ----- |
| No instruction (personal `CLAUDE.md` only) | 0.125 |
| Shipped instruction                        | 1.000 |

Against a real-world baseline of 0/16 measured on the live install, so the harness sits in the same
regime as production.

Re-measured with this harness once `user` was dropped, which is the stronger evidence because the
instruction is then the only thing that can steer:

| Instruction                                          | M                |
| ---------------------------------------------------- | ---------------- |
| Neutered — mentions offload, never names the wrapper | 0.000 (0/8, n=3) |
| Shipped                                              | 1.000 (8/8, n=4) |

## Reading a bad result

- **M below threshold** — the instruction stopped steering the model. That is the real regression
  this guards.
- **A run that did not complete** — fails in both modes. Under `--fallback` that is the whole
  assertion: offload is unavailable, so the agent must degrade to a Claude subagent and still
  deliver. That guardrail is what chose injection over removing the `Agent` tool.
- **"No subagent dispatches at all"** — the harness did not exercise routing. Check
  `trial-*.err` and the run logs for a `Bash` failure _before_ concluding anything: two reviewers
  once scored M = 0.000 on an `EPERM` that stopped Bash from working at all, which says nothing
  about the instruction. The scorer refuses to report a share in this case rather than hand back a
  confounded zero.

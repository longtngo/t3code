# Provider child processes must not inherit the server's `NODE_OPTIONS`

## Problem

The server hands its own `process.env` to every provider CLI it spawns. `NODE_OPTIONS` is the
server runtime's private tuning, and forwarding it breaks any provider CLI whose runtime rejects a
flag the server happens to use.

This is not hypothetical. On a machine whose launchd plist sets
`NODE_OPTIONS=--max-old-space-size=24576 --inspect-port=9230`, the `claude` CLI (a Bun-compiled
binary; Bun does not implement `--inspect-port`) **exits 1 in 0.11s writing nothing to stdout or
stderr**. Every Claude text-generation call — thread titles, commit messages, PR content, branch
names — failed for two months. 178 logged failures; 100% of threads created since 2026-08-04.

Full analysis: `~/reports/t3code/2026-08/2026-08-16/2026-08-16-claude-textgen-node-options-rca.md`.

Isolation (one variable per arm, live binary):

| `NODE_OPTIONS`                                     | Exit               |
| -------------------------------------------------- | ------------------ |
| `--inspect-port=9230` (any port, free or occupied) | **1**, zero output |
| `--max-old-space-size=24576`                       | 0                  |
| unset                                              | 0                  |

The flag is the trigger; the _class_ of defect is that a server-runtime concern leaks into an
unrelated process.

## Approach

Strip `NODE_OPTIONS` in `mergeProviderInstanceEnvironment`, the single function all five drivers
(Claude, Codex, Cursor, Grok, OpenCode) already call to build a provider instance's environment.

The ordering carries the design: strip the **inherited** value, then apply per-instance overrides.
So a user who deliberately sets `NODE_OPTIONS` on a provider instance still wins, while nobody
inherits the server's copy by accident. Deliberate configuration is preserved; accidental
inheritance is not.

This also covers provider maintenance (`claude update`, `npm i -g …`), which resolves its env from
the same merged object — those commands run under `npm`/`bun` and would break identically.

### Why this boundary

`mergeProviderInstanceEnvironment` means "the environment for a provider instance". Node-runtime
tuning for _this_ process is not part of that, so removing it is a clarification of the function's
existing contract rather than a new rule bolted on elsewhere.

## Alternatives rejected

**Strip inside `ChildProcessSpawner`.** Would also cover `npm`/`bun`. Rejected: that spawner is
shared with `packages/ssh`, `packages/tailscale`, `relayClient`, and `effect-acp`. A generic spawner
that silently edits the caller's environment is surprising, and the blast radius is far wider than
the defect.

**Fix `makeClaudeEnvironment` only.** Rejected: fixes one provider. Codex, Cursor, Grok and OpenCode
CLIs have identical exposure, as do the adapter and maintenance paths.

**Filter individual flags, keeping `--max-old-space-size` and dropping only `--inspect*`.** Rejected:
requires parsing a runtime-specific flag grammar we do not own, and the accepted set differs between
Node and Bun — so the filter would need to know which runtime each provider CLI is built on. The
server's own heap cap is meaningless to a provider CLI regardless. Machinery for no gain.

**Remove `--inspect-port` from the local plist.** That is the operator's immediate unblock and is
worth doing, but it fixes one machine and leaves every other user exposed. Complementary, not a
substitute.

## Files touched

- `apps/server/src/provider/ProviderInstanceEnvironment.ts`
- `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`

## Verified premises

- All five drivers call `mergeProviderInstanceEnvironment` at `create` and pass the result to the
  adapter, text generation, the capabilities probe, and maintenance — checked in each driver.
- `NODE_OPTIONS` appears nowhere else in the repo, so nothing depends on forwarding it.
- No caller compares the returned env by identity, so always copying (instead of returning `baseEnv`
  by reference when there are no instance overrides) is safe.
- Stripping restores a working call — the `unset` arm above.

## Tradeoffs and limitations

- A provider CLI that genuinely wants `NODE_OPTIONS` must now receive it explicitly as a
  per-instance environment variable. That is the intended escape hatch, not a workaround.
- **Residual:** several lower-level helpers default to `?? process.env` when called without an
  environment. In production the drivers always pass the merged env, so those defaults are not on
  the failing path; broadening them would be a larger diff with no demonstrated exposure. Left
  as-is deliberately.
- This does not surface text-generation failures in the UI. That silence is what let the defect hide
  for two months, and it is a separate concern — see follow-ups.

## Design review

No `review-technical-design` pillar sweep: none of its triggers fire (no service boundary, API or
event contract, no data model or migration, no new external dependency, no deployment/rollout
change, no personal data, money movement, bulk mutation, or side-effecting agentic action). Recorded
as a decision, not a default. Lenses run: correctness, simplicity, compatibility — the change is
under 300 LOC, so one round.

**Correctness (critical, applied).** The function currently returns `baseEnv` unchanged when an
instance has no environment overrides. Adding the strip only to the copy branch would skip it in
exactly the default case — which is the broken one. The function must always copy and strip. This
gets its own test, because it is the failure the naive implementation produces.

**Correctness (applied).** `process.env` is case-insensitive on Windows, but `{...process.env}`
produces an ordinary case-sensitive object, so a `NODE_OPTIONS` stored under different casing would
survive a literal `delete next.NODE_OPTIONS`. The repo ships Windows support (`resolveSpawnCommand`
has win32 branches), so the strip is case-insensitive.

**Simplicity (applied).** No constant list, no new module, no exported helper for one variable.
Generalize only if a second variable ever needs the same treatment.

**Compatibility (accepted).** Providers no longer inherit `NODE_OPTIONS`. This is the intended
behavior change, and the per-instance override is the escape hatch. This repo has no `CHANGELOG.md`
(the only one is vendored under `.repos/`), so that step is N/A. No user or internals doc currently
documents per-instance environment variables; adding that surface for a bug fix would be scope
creep, so the behavior is recorded here instead.

## Follow-ups deferred

1. **Surface text-generation failure in the UI.** Every path ends `logWarning` → complete with no
   title, so a crashed CLI is indistinguishable from "the model chose not to rename". A user-initiated
   "Regenerate title" in particular should report failure. Multi-surface (web + mobile), so it is its
   own change.
2. **Report a non-zero exit with no output distinctly** (`exit 1, no output`) rather than a bare
   code, so the next occurrence of this shape is diagnosable from the log alone.
3. **Re-title the ~201 affected threads** once a fixed server is running.

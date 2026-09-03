# Switch a thread between instances of one driver — design

**Date:** 2026-09-03 · **Branch:** `feat/same-driver-instance-switch`

## Goal

A thread on the work Claude subscription (instance `claudeAgent`, default config dir) can be moved
to the personal one (`claudeAgent_personalsub`, `~/.claude-personal`) mid-thread, and back. Moving
to a different driver (Claude → Codex/Cursor/OpenCode) stays blocked exactly as today.

## What actually blocks it today (measured)

Switching instances is already wired end to end: the picker allows same-driver instances, the
selection rides `thread.meta.update` / `thread.turn.start.modelSelection`, and the reactor
restarts the session on `instanceChanged` carrying `activeSession.resumeCursor`
(`ProviderCommandReactor.ts:809-832`). Two gates sit in front: driver kind must match
(`:706-712`, keep) and the two instances' `continuationKey` must match (`:715-723`, duplicated
in `ProviderService.ts:670-690`).

Claude's key is `claude:home:${HOME}:config:${CLAUDE_CONFIG_DIR}` (`ClaudeHome.ts:69-76`). The
two live instances differ only in config dir, so their keys differ and the switch is refused with
"provider resume state is incompatible".

The premise behind that key is that a different config dir means a different transcript store.
On this machine it does not: `~/.claude-personal/projects` is a symlink to `~/.claude/projects`
(as are `sessions`, `session-env`, `history.jsonl` and eleven more). Probe, 2026-09-03: a session
run under the default dir, resumed with `CLAUDE_CONFIG_DIR=~/.claude-personal claude -p --resume
<id> --fork-session`, answered from the transcript ("discard the current branch", the thread's
first message); the original file was untouched and the forked files were removed.

Baseline @ 8537c8bad: `makeClaudeContinuationGroupKey({homePath:""})` →
`claude:home:<H>:config:` vs `({homePath:"", configDirPath:"~/.claude-personal"})` →
`claude:home:<H>:config:<H>/.claude-personal` (per `ClaudeHome.test.ts:37,103`): different, so
the reactor refuses. Target: equal keys for these two, still different for two config dirs whose
`projects` are different directories; cross-driver still refused.

## Approach

Key the Claude continuation group on the **transcript store**, not the config-dir string, and let
a persisted resume cursor follow the thread across instances that share a store.

- `apps/server/src/provider/Drivers/ClaudeHome.ts` — `makeClaudeContinuationGroupKey` resolves
  the effective config dir (`configDirPath`, else `<resolved HOME>/.claude`, which is what the
  CLI uses when `CLAUDE_CONFIG_DIR` is unset), then normalises through the **deepest existing
  ancestor**: `realpath(configDir)` (falling back to the resolved string), join `projects`, and
  `realpath` that too when it exists. Key: `claude:store:<path>`. Without the ancestor step a
  missing `projects` yields `/var/...` and an existing one `/private/var/...` for the same
  instance, so the key would flip the first time Claude runs (measured by both reviewers).
  `--resume` reads `<configDir>/projects/<cwd>/<id>.jsonl`; two instances whose `projects`
  resolve to one directory can resume each other's sessions, two that do not, cannot. HOME
  drops out of the key on purpose: with `CLAUDE_CONFIG_DIR` set, HOME does not locate the
  transcript (two instances with different HOME and the same config dir now share a key; a
  test says so). The signature gains `FileSystem.FileSystem`, already in the driver's
  environment (`ClaudeDriver.ts:111,130`), and keeps `never` in the error channel.
  Stated assumption: `projects` is the store `--resume` needs. On this machine `sessions`,
  `session-env` and `history.jsonl` are linked too, so the probe cannot separate "projects is
  sufficient" from "everything is shared"; `CodexHomeLayout.ts:19-31` treats a shared store as
  a list for the same reason. If a resume ever fails with only `projects` linked, widen the key.
- **Precedent, not novelty:** Codex already does this — `codexContinuationIdentity` keys on the
  shared home (`CodexDriver.ts:110`, `CodexHomeLayout.ts:55,64`), so two Codex accounts in
  overlay mode continue one thread today. Upstream's Claude key is the resolved HOME alone
  (`origin/main:ClaudeHome.ts:37-42`); the fork's config-dir suffix is fork-added, so this
  change replaces fork lines, not upstream ones.
- The fork path (`forkFrom`) carries the parent cursor across a shared-store sibling by the
  same key comparison, since `--resume --fork-session` was the design's own probe.
- `apps/server/src/provider/Layers/ProviderService.ts:712-724` — the persisted cursor and cwd
  are inherited only when `persistedBinding.providerInstanceId === resolvedInstanceId`. With
  the gates passing, a switch with **no live session** (after a stop, a server restart, the
  reaper) would fall to `startProviderSession` with no cursor and silently start a fresh
  conversation — the exact outcome this design refuses to accept. Inherit both when the two
  instances' `continuationIdentity.continuationKey` match, which the same function already
  computes three lines above (`:680-690`).
- Reactor: one added gate — a switch while `thread.session.activeTurnId` is set is refused with
  a message naming both instances. Otherwise nothing changes. With a live session `instanceChanged` restarts and hands the live
  cursor over (`ProviderCommandReactor.ts:809-832`); the restarted session is re-stamped with
  the new instance (`ProviderService.ts:764-767`) and bound (`ProviderCommandReactor.ts:762-786`).
  Observability: the restart log adds both continuation keys, and the adapter's resume span adds
  `claude.store` beside `claude.resume.session_id` — today nothing anywhere logs which store a
  session is bound to.
- `apps/mobile/src/lib/modelOptions.ts` + `apps/mobile/src/features/threads/ThreadComposer.tsx:481-486`
  — mobile discards `provider.continuation` entirely, so "same group" cannot be filtered on
  today. `ModelOption`/`ProviderGroup` gain `continuationGroupKey: string | null`, and the
  picker's filter is web's predicate ported, not re-derived (`ChatView.logic.ts:343-357`): same
  driver, **both** keys present and equal, Antigravity requires the exact instance when its key
  is missing, and the thread's own group is always kept (a `groupKey === undefined` on an older
  server must not pair two unknowns, and a disabled current instance must not empty the
  picker). The current instance is `session?.providerInstanceId ?? modelSelection.instanceId`,
  as the provider rail and web resolve it.
- Web: no picker change; the gates it mirrors compare keys already.

### Accepted behaviours, named

- A switch under a running turn is **refused** ("stop it before switching"). The fork's queue
  is adapter-level; the reactor restarts the session on any selection change at once, so a
  switch mid-turn would abandon the running turn (measured by the whole-branch review; a
  model-only change already behaves that way and is not changed here). The old gate refused
  this case too, so nothing is lost.
- Once `thread.modelSelection` names the new instance, a later `thread.runtime-mode-set`
  restart lands on it without a send. That is the switched state, not a leak.
- If the user later removes the symlink, a thread already moved resumes against a store that no
  longer holds its transcript and the CLI errors; today's refusal would have happened earlier.
  The key is recomputed per boot, the log line names the store, and resume-failure recovery is
  an improvement suggestion, not built here.
- Privacy and grants, deliberate: after a switch the whole conversation continues under the
  other account, **including that account's `.claude.json` tool grants and trust state**
  (`~/.claude-personal/.claude.json` is a real file, not a link). That is the request.

## Surfaces

- Web/desktop: no picker change; switching now succeeds where it was refused. Reverse: switch
  back the same way.
- Mobile: picker widened to the continuation group with the ported predicate.
- Providers: Claude changes; Codex already behaves this way; Cursor, Grok, OpenCode, Antigravity
  keep the default per-instance key (`ProviderDriver.ts:87-94`) — "not supported here".
- Docs: `docs/user/providers-claude.md` "Can I Switch Claude Accounts In An Existing Thread?"
  currently says "usually no" and explains the config-dir rule; rewrite to: yes when the two
  config directories share one `projects` directory (a symlink), otherwise no, with the
  precedent-and-caveat. `docs/fork/README.md` gets an invariant.

## Alternatives rejected

- Copy the transcript across stores on switch (a driver `migrateContinuation` hook): the real
  answer for two unlinked config dirs, and more machinery than this setup needs. Deferred as an
  improvement suggestion; the key change is a prerequisite for it anyway.
- Drop the continuation gate for same-driver switches: silently loses the conversation for two
  unlinked stores. Rejected.
- Key on HOME + config dir but let the user override per instance: a setting that restates what
  the filesystem already says.

## Tests

- `ClaudeHome.test.ts`: two configs whose `projects` resolve to one temp directory (real dir +
  symlink) → equal keys; two real temp directories → different; missing `projects` under a
  symlinked config dir → same key before and after the directory is created; different HOME,
  same config dir → equal; existing key-format assertions retargeted.
- Neither gate has a test today ("resume state is incompatible" appears only in the two
  production strings), and the reactor test's `getInstanceInfo` mock hard-codes
  `claudeAgent:instance:<id>` for every claude id, so a same-key switch cannot be expressed
  without extending it. Add: reactor same-key switch with a live session (restart carries the
  cursor, session re-stamped), reactor different-key refusal, cross-driver refusal kept,
  `ProviderService.startSession` inheriting the persisted cursor and cwd across instances with
  equal keys and not across unequal ones.
- Mobile: the ported predicate as a pure function in `modelOptions.ts` with cases for equal
  keys, missing keys, Antigravity, and a disabled current instance.

## Review exit

6a (pillars) and 6b (correctness, simplicity, compatibility) ran in parallel, one round, both
built the key function and ran it. Applied: ancestor-normalised fallback, the stopped-session
cursor inheritance (HIGH), mobile threading + ported predicate, HOME-drop test, store logging,
Codex precedent and upstream-key correction, `projects` assumption stated, `.claude.json`
grants in the privacy note, doc page corrected, missing-test finding. Accepted with a sentence
each: mid-turn overlap, runtime-mode restart, symlink removal. Rejected: none. Round 2 not run:
every edit is inside the dimensions both lenses already traced.

## Follow-ups deferred

- Transcript migration for unlinked stores.
- Resume-failure recovery when a store no longer holds a session (improvement suggestion).

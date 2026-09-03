# Per-thread subagent offload + master switch — design

**Date:** 2026-09-03
**Branch:** `feat/thread-subagent-offload`
**Status:** revision 6 — final; CONDITIONAL GO after five review rounds (21 build-and-run runs)

## Goal

The subagent offload feature (`subagentBackend`) is machine-global today: one JSON file at
`~/.local/state/subagent-dispatch/backend.json` decides whether coding agents on this host dispatch
their subagents through Cursor. Three changes:

1. **Per-thread override** — a thread inherits the global setting and can override it either way.
2. **Master switch** on Settings → General; off hides the per-thread control and stops offload for
   every T3 Code thread. It does not govern the machine-global file — see "Master switch".
3. Both must hold on the surfaces that can actually reach the feature.

## Baseline @ `ee32cdada` (2026-09-03)

Source-scoped (revision 1's commands matched `apps/web/dist` artifacts):

```
per-thread mode field in settings:  grep -c 'subagentBackendThreadModes\|subagentBackendEnabled' \
                                      packages/contracts/src/settings.ts                  → 0
thread-scoped backend refs (src):   grep -r subagentBackend <src dirs> | grep -ci thread  → 0
server injects SUBAGENT_BACKEND_STATE (src):                                              → 0
threadId path-encoding helper in subagentBackend/:                                        → 0

regression floor: pnpm verify @ d2bb199d4 → exit 0
  web 336 files / 4092 tests · server 324 files (2 skipped) / 4002 tests (10 skipped)
```

## Approach

### The env carries a path, not a decision

The spawn env is frozen for a session's lifetime (`updateEnv` has zero callers in
`apps/server/src`), so `SUBAGENT_BACKEND_STATE` carries a **stable per-thread path**. The wrapper
re-reads that path on every dispatch (`bin/subagent-dispatch:10,31,44`), so contents change
mid-session with no respawn. Verified: rewriting between dispatches in one frozen-env subshell gave
`--model opus-first` (rc 0) → refuse (rc 3) → `--model sonnet-later` (rc 0).

Pointing inheriting threads at the _global_ path was prototyped and failed: a thread that was
`inherit` at spawn holds that path forever, so flipping it off does nothing until respawn.

### Files

```
<stateDir>/subagent-threads/<Encoding.encodeBase64Url(threadId)>.json
```

Every per-thread path is a **regular file**, always written by `writeFileStringAtomically`, then
`chmod 0600`; the directory gets an unconditional `chmod 0700` (`makeDirectory(recursive: true)`
no-ops on mode for an existing directory). Revision 3 used a symlink for inheriting threads; round 3
reproduced five failure modes (write-through to the global toggle, chmod-through, non-idempotent
create on the common path, `exists()` blind to dangling links, no atomic swap) and established that
`off`/`inherit` transitions need a writer regardless, so the symlink's only benefit was skipping
inherit-thread rewrites on a global change — 3 live sessions, ~2 ms.

`<stateDir>` is the **per-environment** state directory from `deriveServerPaths` (`config.ts:111`).
Verified live: three server shapes on one `$HOME` (desktop `~/.t3/userdata`, worktree `.t3/dev`,
explicit `--home-dir`) get three distinct `threads/` directories and read the same global file.

**Path encoding.** `Encoding.encodeBase64Url(threadId)`, mirroring `checkpointing/Utils.ts:8` and
`terminal/Manager.ts:1005` — not `legacySafeThreadId` (`:1001`), which collides `a/b` with `a_b`.
`ThreadId` is `TrimmedNonEmptyString` + brand (`baseSchemas.ts:86-90`) with no charset or length
constraint, client-supplied on `thread.create` (`orchestration.ts:933`) and `thread.fork` (`:949`)
under a standard scope. Revision 1 interpolated it raw and reviewers wrote onto the production global
toggle. base64url's alphabet contains neither `/` nor `.`, so containment is structural.

**Length bound: 243 encoded characters** (182 UTF-8 bytes). `writeFileStringAtomically` builds an
`mkdtemp` template of `basename + ".XXXXXX"`, and `encodeBase64Url` runs `TextEncoder` first, so
100 CJK characters throw `ENAMETOOLONG` while passing a `.length <= 182` check. The writer rejects on
`encodeBase64Url(threadId).length > 243`. Injective over well-formed UTF-16 only — lone surrogates
map to U+FFFD. All 516 live ids are 36-char UUIDs.

### Resolution

| `enabled` | thread mode | global file | per-thread file                                                                                                                                                          |
| --------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| false     | any         | any         | `OFF`                                                                                                                                                                    |
| true      | `off`       | any         | `OFF`                                                                                                                                                                    |
| true      | `inherit`   | cursor      | copy of the global file's resolved content                                                                                                                               |
| true      | `inherit`   | default     | `OFF`                                                                                                                                                                    |
| true      | `on`        | cursor      | cursor, global file's `instanceId`/`model`                                                                                                                               |
| true      | `on`        | default     | `resolveCursorTarget(settings, cursorInstances(settings)[0]?.instanceId)`, model `"auto"` (the wrapper's default and `setBackend`'s, `:304`); `OFF` if it cannot resolve |

`OFF` is the module's existing constant, written as-is on the rows that name it plainly; the
master-off row carries `degraded: MASTER_OFF_REASON`, and the rows that copy or resolve a target
carry whatever reason that source produced. Nothing reads `degraded` from a per-thread file — the
wrapper's `jq` selects four fields (`:44-49`) and its refuse message prints only the path (`:53`) —
and the sidebar presenter renders any non-null `degraded` as an amber "Degraded"
(`sidebarSubagentBackend.logic.ts:35`). A file rather than absence
buys one write path: no `remove` branch, no exists-guard.

`resolveCursorTarget(settings, instanceId)` is one helper extracted from the two identical blocks at
`SubagentBackend.ts:297-303` and `:408-414` (validate → `resolveCommandPath` → degraded message);
the `on` row is its third caller, net −8 lines.

`on` prefers the global file's `instanceId` so an `on` thread resolves the _same_ instance the
global control does; `cursorInstances(settings)[0]` is `Object.entries` insertion order and would
have rerouted `on` threads when two instances are enabled — exactly when the instance picker
renders. This is why no separate selection field exists: revision 2 added one, and a reviewer built
the alternative, ran it (`on` while the global read `default` → rc=0), and found the field cost ~31
lines and broke 4 existing tests.

`resolveCommandPath` is a memoised filesystem scan — 0 subprocesses, 3.78 ms cold
(`shared/src/shell.ts:499-528`). Revision 1 called it "a subprocess-touching step", inherited from a
shipped comment at `SubagentBackend.ts:270`; the comment is corrected too.

### Storage

```ts
subagentBackendEnabled: Schema.Boolean; // default true
subagentBackendThreadModes: Schema.Record(ThreadId, Schema.Literals(["on", "off", "inherit"])); // default {}
```

**`"inherit"` is a patch sentinel, not a stored value** (revised — see revision 8): the merge strips
it afterwards, so a `{ t2: "inherit" }` patch deletes `t2` and the persisted map holds only real
overrides. The rationale below is otherwise as shipped.
`applyServerSettingsPatch` routes through `deepMerge`
(`shared/src/serverSettings.ts:192`, `Struct.ts:9-22`), which never deletes — an absent-key
convention was a one-way door. With a sentinel, a single-key patch `{ t2: "inherit" }` sets `t2` and
preserves siblings, and two devices patching different threads both land (verified through the real
function and the real settings layer). No RPC, no whole-map replacement. Revision 3's `setThreadMode`
RPC rested on a race claim that was itself wrong: `getSettingsFromCache` runs inside `writeSemaphore`
(`serverSettings.ts:790`).

Both fields get `ServerSettingsPatch` entries — the parity test at `settings.test.ts:734` requires it
unless a field is in `deliberatelyUnpatchable`, the repo's mechanism for `defaultTheme` and
`disableAuthentication` (`settings.ts:178-181`, `:1411-1415`). The map is deliberately patchable and
**stays on the settings broadcast**: 5 overrides add 77 bytes deflated, 50 add 1.1 KB, live sessions
never add entries, and the broadcast is what makes the control reactive across devices for free.

Hazards, stated: keys are trimmed on decode, so `{" x ":"on","x":"off"}` collapses last-wins with no
error, and the filename is encoded from the _stored_ key; `{"__proto__":"on"}` decodes to an own
property that `deepMerge` silently discards (harmless with a string value; load-bearing if the value
ever becomes an object); an invalid **value** costs that field alone — both new fields carry `catchDecoding`, so the map
degrades to `{}` and the master to `true` (see revision 8) — not UI-reachable, reachable by downgrade
if the value set grows; the
schema accepts keys of any length and count (10,000 × 200-char keys → 2.2 MB `settings.json`), which
costs decode and broadcast, never writes, since the writer never iterates the map. Follow-ups.

### The writer

`reconcileThreadBackends`: enumerate **live sessions only**, resolve each per the table, write,
chmod. Enumeration is `ProviderAdapterRegistry.listInstances()` → `getByInstance(id).listSessions()`
per adapter (`ProviderAdapterRegistry.ts:40,52`; adapter `listSessions` is `Effect.sync` over a map,
`ProviderAdapter.ts:103`), de-duped by `threadId`. **Not** `ProviderService.listSessions()`: it
validates persisted bindings inside its loop and `Effect.die`s the whole call on a mismatch
(`provider/Layers/ProviderService.ts:1155,1163`), which is reachable transiently between
`adapter.startSession` and `upsertSessionBinding` (`:732`) — a batch landing there would write zero
files, and on the `setBackend` path there is no watcher echo to retry. The writer needs only thread
ids. Pinned-but-idle threads are not iterated: session start writes them, and a thread with no live
agent has nothing to read the file. Population is live sessions (3 on this host, ~2 ms), not the map.

**One lock, one ordering, by structure.** Everything runs under the existing
`backendWriteSemaphore`; no second semaphore. Two entry points:

- `reconcileThreadBackends` — one permit: read settings via `getRawSettings` → `reconcileBackendBody`
  (the global reconcile, split from its permit the way `writeBackendFileBody` already is) → read the
  global file → batch. The subscriber in `subagentBackendReconciler` calls only this.
- `setBackend` — **its three write exits collapsed into one permit block** (`:284`, `:292`, `:327`
  today; the first two go through `writeBackendFile`'s own permit with no settings read, so an
  implementer following revision 5 literally left `set(default)` both ungated and without the
  writer). Inside the permit: read settings → master-switch check → validate → write global body →
  batch body. Reproduced: hooking only the cursor exit reached the thread after global→cursor but
  left it on `cursor` after global→default.
- Session start (`ProviderService`, before **both** `adapter.startSession` sites, `:486` recovery and
  `:708` start) — the batch body for that one thread, under the permit, awaited so the first dispatch
  never sees a missing file. No ordering against the reconciler is claimed here: it is `forkScoped`
  at `serverRuntimeStartup.ts:808` and recovery runs at `:815`, concurrently. Session start reads
  whatever global file is current.

Ordering after the global reconcile is therefore a function body at the two places it matters, not
a rule at three. Measured: three race shapes (master-off vs `set(cursor)`, `set(default)` vs
mode-`on`, instance-disabled vs `set(cursor)`), 400 each — 0 wrong, 0 unconverged, no timeout; a
300-round × 4-fiber storm completed in 1.17 s with no deadlock. Without a lock: 24/400 divergent.
With a lock but a settings _argument_ arriving late: 400/400. **The batch body must never call
`writeBackendFile`** — `withPermits` is non-reentrant, and a mutation that does deadlocks the storm
at round 0.

- **`Effect.catchCause` per item** (was `Effect.exit`; same class). `Effect.result` does not capture `Effect.die` (reproduced). One
  over-length id must not abort the batch: with `Effect.forEach` and no per-item catch, 267 of 467
  files went unwritten.
- Runs twice per settings save — `emitChange` (`serverSettings.ts:805`) and the file watcher's echo
  ~100 ms later (`:716,752`). Idempotent; bounded by live sessions.
- Session start writes a file for **every** provider's thread, not only Claude's; only Claude's
  spawn reads it. Consistent with the stale-file tradeoff, stated rather than gated.

### Master switch

`subagentBackendEnabled`, default `true`, so existing installs are unchanged. Off:

- every live thread's file is written `OFF` by the batch, and every new session starts `OFF`;
- `subagentBackend.set` refuses a Cursor selection inside the collapsed permit block, on every
  exit, but still admits `default` — as shipped, so the master switch is not a one-way door that
  strands the machine-wide file on a Cursor target (revised — see revision 8);
- the per-thread control is hidden under master-off; a note naming the thread's server appears only
  when that server's master disagrees with the primary's (revised — see revisions 8 and 9).

**What it does not touch: the machine-global file.** Earlier revisions forced `backend.json` to
default so non-T3 callers (a terminal Claude session) would stop too. That was the source of three
defects — a blast radius from a per-environment setting mutating a machine-global file (two servers
with opposite switches fought over it on every reconcile), an "enforced once" caveat, and a master-on
asymmetry (pinned threads resumed on `instances[0]` because forcing nulled the pick). None of it is
needed to stop any T3 thread. **The T3 master switch governs T3 threads; the sidebar's global toggle
governs the machine file, as today.** Master-off destroys nothing; master-on re-runs the batch and
every thread returns to its table row — verified across five scenarios with the global file
byte-identical throughout.

**Consequently the global toggle stays visible under master-off**, with only Cursor, the instance
picker and the model picker dimmed while Default stays operable (revised — see revision 8), because
it governs a file the switch deliberately does not. Hiding it would show a user no offload UI while
the machine still offloads — the reverse-state failure AGENTS.md names. This is a second deviation from "hide the offload settings everywhere", stacked on the first;
both reverse together with one bullet, and the report flags it.

The population that reads the global file directly — no `SUBAGENT_BACKEND_STATE` — is: terminal
sessions, sessions alive across this upgrade, and threads of an **older T3 server on the same host**
(this fork runs a production and a worktree server side by side). Recovery (`:486`) self-heals a
pre-upgrade thread on its next turn.

Not an authorization boundary: `serverUpdateSettings` and `subagentBackendSet` share one scope
(`auth/RpcAuthorization.ts:42,151`), so gating `set` stops a stale client, not a current one.

### Enforcement surface — Claude only

`~/bin/subagent-dispatch` is invoked only because a `CLAUDE.md` instruction says so; `AGENTS.md` has
zero references, and Codex, Grok and OpenCode read `AGENTS.md`. Injecting into them governs nothing
and is not free: materializing `environment` for **Grok changes its auth method**
(`provider/acp/GrokAcpSupport.ts:65-69`), and OpenCode's (`provider/opencodeRuntime.ts:645-670`)
carries a note about clobbering the user's config. Claude only; the rest an explicit "not
applicable". Rests on one developer's dotfiles; follow-up.

The injection is one line at the consumption site `provider/Layers/ClaudeAdapter.ts:5024` — never
in `makeClaudeEnvironment`, built once per adapter (`:2083`) and returning its base env **by
reference** when no override is set (`provider/Drivers/ClaudeHome.ts:43-48`).

### Surfaces

| Surface                          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web sidebar Subagents panel      | global control (existing; visible under master-off) plus a "This thread" 3-segment control reading `useEnvironmentSettings(environmentId)` (`useSettings.ts:322`, per-environment, reactive to `settingsUpdated`) — both `subagentBackendThreadModes[threadId] ?? "inherit"` and the `subagentBackendEnabled` hide gate — and gated on **that environment's** `serverConfig.capabilities` (pattern at `state/entities.ts:184-230`), not the existing panel's primary-scoped shape (`SidebarSubagentBackend.tsx:62-74`). Writes a one-key patch through `server.updateSettings` |
| Settings → General               | master switch, `serverScoped` row gated on `primaryServerConfigAtom` capabilities as `threadAutoSettlement` is (`SettingsPanels.tsx:1996-1997`)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Settings search                  | the same gate at `useAvailableSettingsSearchItems.ts:45`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Desktop                          | wraps web                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Mobile                           | deferred; zero subagent plumbing exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Claude adapter                   | one-line env injection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Codex / Cursor / Grok / OpenCode | not applicable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The master switch, like every `serverScoped` General row, is editable only for the primary
environment (`usePrimarySettingsAvailable`, `useSettings.ts:346-349`). Same limitation as every
other server-scoped setting; not solved here.

**Capability flag** `EnvironmentCapabilities.subagentBackendThreadModes`, `optionalKey` like its
siblings, emitted at `environment/ServerEnvironment.ts:211-234`. The existing `subagentBackend` flag
is hardcoded `true` (`:226`) and cannot discriminate; against a real older server both controls
rendered, accepted input, and silently snapped back. The descriptor is typed
`ExecutionEnvironmentDescriptor` (`:203`), but the key is optional, so forgetting to emit compiles
clean — a test pins it.

## Test plan

Settings-change-driven paths use the **real** layer against a temp settings path, never `layerTest`
— it returns `subscribeChanges: Effect.succeed(Stream.empty)` (`serverSettings.ts:248`).

- The resolution table, every row.
- Path encoding: traversal inputs; the 243-encoded-char bound with a non-ASCII case (100 CJK
  rejected, 60 CJK + 2 ASCII accepted).
- Every transition with regular files: `inherit→on→off→inherit`, `on→inherit` direct.
- **A global toggle click reaches a live inheriting thread, both directions**, including
  `set(default)` — the exit revision 5 left uncovered.
- Two concurrent writers under the module semaphore with in-permit reads: 0/400; the same harness
  shown diverging without the lock. **The batch body never calls `writeBackendFile`** — a mutation
  that does must deadlock the probe.
- The writer runs after the global reconcile at the subscriber: an `on` thread whose global pick was
  just disabled resolves to the surviving instance.
- A single-key patch to `"inherit"` preserves siblings; a concurrent pair both land.
- Master-off: `set` refused on every exit; every live file `OFF`; the global file byte-identical;
  master-on restores every file per the table.
- Per-item isolation: one over-length id, the rest written. A per-adapter `listSessions()` that
  throws is caught per adapter, the others enumerated.
- File `0600`, directory `0700` on a pre-existing `0755` directory.
- The capability flag is emitted, and all three surfaces hide without it.
- Both `startSession` sites write before spawning.
- `SubagentBackend.set.test.ts` and `.reconciler.test.ts` gain `ProviderAdapterRegistry` and
  `ServerConfig` stubs — the writer grows `setBackend`'s requirement set.

Every guard is mutation-tested: removed, its own case watched go red, restored.

## Tradeoffs and known limitations

- **Per-thread "off" is advisory.** The agent has a shell and can unset the variable (the wrapper's
  `:-` default treats empty as unset) or run `cursor-agent` directly.
- **The master switch does not govern non-T3 callers**, and the global toggle stays visible under
  it. One bullet to reverse both.
- **A spawn window.** `ProviderService` writes at `:708` before `adapter.startSession`, and Claude
  registers the session at `ClaudeAdapter.ts:5142` after its model catalog and env build. A settings
  change landing in that window triggers a batch that cannot see the thread; its file keeps the
  pre-change content until the next settings save. Bounded, self-healing.
- **A downgrade silently drops the master switch key**, and `withDecodingDefault(true)` fails open.
  Accepted: default-on preserves behaviour for anyone who never touches it.
- **The thread-mode map has no size bound.** Follow-up. (An unknown mode value no longer wipes
  settings.json — `catchDecoding`, revision 8.)
- **`apiEndpoint` reaches four sinks unredacted** already; `0600`/`0700` here.
- **Stale per-thread files** are not cleaned up: every thread that ever spawns, on any provider,
  gets one (~200 bytes, `0700` directory); self-healing at next session start.
- **Version skew is silent, not an error.** The capability gate is load-bearing, not defensive.
- **Upstream drift**: settings storage moves state into `settings.ts`, the second-hottest file in
  the last 112-commit merge.

## Follow-ups deferred

- Constrain `ThreadId` to a slug/UUID with a length bound at the schema; bound the thread-mode
  record's key count.
- A forward-compatible thread-mode value shape.
- Promote `verifyMigrationSlots` (`scripts/migrate-dev-db.ts:337-349`) to startup — a duplicate
  migration id is skipped and logged as success.
- `--` before `"$binary"` in the wrapper repo.
- Redact `apiEndpoint` on the client wire.
- A guard that the dispatch instruction still lives where Claude-only injection assumes.
- Mobile control; per-thread choice of a different Cursor instance or model; master switch governing
  non-T3 callers.

## Review exit note

Twenty-one build-and-run reviewer runs over five rounds. Revision 1: NO-GO 2.4/5 (traversal
Critical). Revision 2: NO-GO 2.3/5 (storage one-way doors). Revision 3: NO-GO 2.9/5 (symlink
failure modes, missing transition writer). Revision 4: NO-GO 3.1/5, one blocker. Revision 5:
**CONDITIONAL GO 3.9/5**; the security/compatibility lens returned no Critical or High for the third
consecutive round; the simplicity lens declared the design at its floor (10 files, ~120 prod lines,
from 17 files / ~330 in revision 1); the correctness lens verified every prior finding closed with
mutation controls and a storm test.

Revision 6 folds in the round-5 must-fixes as doc-precision edits — the collapsed `setBackend`
permit block, per-adapter enumeration, one lock with ordering by structure, plain `OFF` on every
row, the `resolveCursorTarget` extraction, the visible-under-master-off global toggle, and the
`__proto__` and older-server notes. Every must-fix is carried into the Stage 7 plan as an explicit
task. Stage 6 exits here.

Revision 7 (post-implementation): corrected two statements this doc got wrong about the shipped
code — the per-thread directory is `<stateDir>/subagent-threads/`, and the master-off row writes a
`degraded` reason (which nothing downstream reads, so behaviour is unchanged).

Revision 8 (post-sanitize): the shipped behaviour this doc now describes, after the second
sanitization round.

- `"inherit"` is stripped server-side after every patch merge, so it is never stored; the map holds
  only real overrides and Revert is a delete.
- Master-off admits `set(default)` and refuses only `set(cursor)`, so the machine-wide file can
  always be cleared.
- The per-thread segment shows a note explaining that offload is off, rather than disappearing
  (superseded by revision 9: hidden when both servers agree, a note only on disagreement).
- Under master-off only Cursor, the instance picker and the model picker are dimmed; Default stays
  operable, and the collapsed row's dot goes grey while its text keeps naming the machine-wide file.
- The thread-mode lookup is prototype-safe (`Object.hasOwn`) and only an explicit `"on"` enables
  offload — thread ids are client-generated, so `constructor` and `__proto__` used to read inherited
  `Object.prototype` members and fall through into the enabling branch.
- Both settings fields carry `catchDecoding`, so a value this build cannot decode costs that field
  alone instead of failing the whole settings document.
- A failed PRE-start write removes the thread's file; the POST-start rewrite does not, because by
  then the pre-start write has already left a good one and deleting it would strand a live
  subprocess with no file at all.
- That post-start rewrite is what closes the registration window: adapters register near the end of
  `startSession`, so a settings change landing in that window enumerates every thread but this one.

## Revision 9 (sanitize rounds 3-5, post-implementation)

- Under master-off on a single environment the per-thread control disappears entirely; the panel's
  own foot note already says offload is off. The "switched off on this thread's server" note renders
  only when the thread's environment has the master off and the primary does not.
- The thread's Cursor choice shows "Add a Cursor instance in Settings to use Cursor here." when the
  thread is on the primary environment, the primary's state has loaded, and no enabled Cursor
  instance exists. A remote thread or a still-loading state offers no Cursor note.
- The prototype-safe mode lookup is one shared helper, `subagentBackendThreadMode` in
  `packages/contracts/src/settings.ts`, used by both the sidebar control and
  `resolveThreadBackend`, with its own test in `packages/contracts/src/settings.test.ts`; on the
  server the `mode !== "on"` shape already rejects prototype members, so `Object.hasOwn` there is
  belt-and-braces.

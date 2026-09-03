# Switch a thread between instances of one driver — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** two Claude instances whose `projects` directories resolve to one path share a continuation key, so a thread can switch between them (web and mobile) and a persisted cursor follows it.
**Spec:** docs/design/2026-09-03-same-driver-instance-switch-design.md

## Global Constraints

- Cross-driver switches stay refused with today's message; different-store Claude instances stay refused with today's message.
- `makeClaudeContinuationGroupKey` keeps `never` in its error channel.
- Server tests: `cd apps/server && pnpm exec vp test run <files>`; mobile: `cd apps/mobile && pnpm exec vp test run <files>`. Typecheck per package with `pnpm run typecheck`. Format with `pnpm exec vp fmt <files>` from the root before each commit. No repo-wide checks, no dev server, never run `claude`, never write under `~/.claude*` or `~/.t3`.

### Task 1: The key is the transcript store

**Files:** Modify `apps/server/src/provider/Drivers/ClaudeHome.ts` (`makeClaudeContinuationGroupKey` ~~:69-76), `apps/server/src/provider/Drivers/ClaudeHome.test.ts` (~~:28-40, ~:96-110 and new cases), `apps/server/src/provider/Drivers/ClaudeDriver.ts` (call site ~:149; no logic change unless the type requires it).

- [ ] Step 1: In `ClaudeHome.test.ts` add, using `fs.makeTempDirectoryScoped` and `fs.symlink` from the `FileSystem` service (the test layer is `NodeServices.layer`):

```ts
it.effect("keys the continuation group on the resolved projects directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-store-" });
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const c = path.join(root, "c");
    yield* fs.makeDirectory(path.join(a, "projects"), { recursive: true });
    yield* fs.makeDirectory(b);
    yield* fs.symlink(path.join(a, "projects"), path.join(b, "projects"));
    yield* fs.makeDirectory(path.join(c, "projects"), { recursive: true });
    const keyA = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: a });
    const keyB = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: b });
    const keyC = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: c });
    expect(keyB).toBe(keyA);
    expect(keyC).not.toBe(keyA);
    expect(keyA).toBe(`claude:store:${yield* fs.realPath(path.join(a, "projects"))}`);
    // Different HOME, same config dir: HOME does not locate the transcript.
    expect(yield* makeClaudeContinuationGroupKey({ homePath: root, configDirPath: a })).toBe(keyA);
  }),
);

it.effect("does not change the key when the projects directory is created later", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-store-" });
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    yield* fs.makeDirectory(real);
    yield* fs.symlink(real, link);
    const before = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: link });
    yield* fs.makeDirectory(path.join(real, "projects"));
    const after = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: link });
    expect(after).toBe(before);
    expect(before).toBe(`claude:store:${yield* fs.realPath(real)}/projects`);
  }),
);
```

Retarget the two existing key-format assertions (`:37-39`, `:103-105`): with `homePath` only → `claude:store:<resolved home>/.claude/projects`; with `configDirPath` → `claude:store:<configResolved>/projects` (temp dirs do not exist, so the resolved-string fallback applies; on macOS `NodeOS.homedir()` is already real). Run `cd apps/server && pnpm exec vp test run src/provider/Drivers/ClaudeHome.test.ts` → the new cases fail.

- [ ] Step 2: Implement:

```ts
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: ClaudeHomeConfig,
  ): Effect.fn.Return<string, never, Path.Path | FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir =
      (yield* resolveClaudeConfigDirPath(config)) ||
      path.join(yield* resolveClaudeHomePath(config), ".claude");
    // Normalise through the deepest existing ancestor so the key is the same before and after
    // Claude creates `projects`, and the same through any symlink on the way.
    const realConfigDir = yield* fs.realPath(configDir).pipe(Effect.orElseSucceed(() => configDir));
    const projects = path.join(realConfigDir, "projects");
    const store = yield* fs.realPath(projects).pipe(Effect.orElseSucceed(() => projects));
    return `claude:store:${store}`;
  },
);
```

Check `resolveClaudeConfigDirPath` returns `""` for a blank config (the test at `:60` expects the blank form) and adjust the `||` accordingly. Update the doc comment above: the key is the transcript store `--resume` reads; two config dirs whose `projects` resolve to one directory share a session store (fork precedent: `codexContinuationIdentity`). Run the test file → green; `cd apps/server && pnpm run typecheck`.

- [ ] Step 3: Commit `feat(server): key Claude's continuation group on the transcript store`.

### Task 2: A persisted cursor follows the thread across a shared store

**Files:** Modify `apps/server/src/provider/Layers/ProviderService.ts` (~:670-724), `apps/server/src/provider/Layers/ProviderService.test.ts`.

- [ ] Step 1: Read how `ProviderService.test.ts` builds its harness (stubbed adapter, `ProviderSessionDirectory`, `getInstanceInfo`/continuation keys). Add two cases: (a) a persisted binding for instance `claudeAgent` with `resumeCursor` and a cwd in `runtimePayload`; `startSession` for `claudeAgent_personalsub` whose continuation key EQUALS the persisted instance's → the adapter's `startSession` receives that cursor and cwd; (b) same but keys differ → today's `ProviderAdapterRequestError` ("resume state is incompatible"). Run → (a) fails, (b) passes today (it is the existing gate — record that it passes before the change too).
- [ ] Step 2: In `startSession`, compute once `const sharesContinuation = persistedBinding !== undefined && (persistedBinding.providerInstanceId === resolvedInstanceId || <the two keys already compared at :680-690 are equal>)`, and use `sharesContinuation` in both `effectiveResumeCursor` and `effectiveCwd` in place of the id equality. Keep the span annotation's `provider.resume_cursor.source` truthful (add a value such as `"persisted-shared-store"` if it names sources). Run the test file → green; typecheck.
- [ ] Step 3: Commit `fix(server): a persisted Claude cursor follows the thread across a shared store`.

### Task 3: Reactor coverage and the store in the logs

**Files:** Modify `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` (mock `getInstanceInfo` ~:377-400; new cases near the two `"cannot switch to 'claudeAgent'"` cases ~:2970, ~:3036), `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` (restart log ~:834-856), `apps/server/src/provider/Layers/ClaudeAdapter.ts` (resume span ~:5058-5064).

- [ ] Step 1: Extend the mock: ids starting with `claudeShared` get `continuationKey: "claude:store:/shared"`, other `claude*` ids keep `claudeAgent:instance:<id>`. Add three cases modelled on the existing cross-driver ones: (a) live session on `claudeShared_a`, turn start with `claudeShared_b` → session restarted (adapter `startSession` called once more) with the previous session's `resumeCursor` and `providerInstanceId: "claudeShared_b"` in the bound session; (b) live session on `claudeAgent_a`, turn start with `claudeAgent_b` → error containing "resume state is incompatible"; (c) the existing cross-driver refusal still passes. Run `cd apps/server && pnpm exec vp test run src/orchestration/Layers/ProviderCommandReactor.test.ts` → (a) fails only if the cursor/instance assertions do (the mock change is what makes it expressible); record what failed.
- [ ] Step 2: Add `currentContinuationKey: currentInfo.continuationIdentity.continuationKey` and `desiredContinuationKey: desiredInfo.continuationIdentity.continuationKey` to the restart `logInfo` object (both values are in scope; if not, pass them from where they are computed). In `ClaudeAdapter.ts` add `"claude.store": <the continuation key or the resolved projects path available in that scope>` next to `"claude.resume.session_id"`; if neither is in scope there, add the key to the `startSession` span in `ProviderService.ts` instead and say so.
- [ ] Step 3: Run the reactor test file and `src/provider/Layers/ClaudeAdapter.test.ts` → green; typecheck; `pnpm exec vp lint` the three files.
- [ ] Step 4: Commit `test(server): same-store instance switch, and log the store`.

### Task 4: Mobile offers the thread's continuation group

**Files:** Modify `apps/mobile/src/lib/modelOptions.ts` (`ModelOption`, `ProviderGroup`, `buildModelOptions`, `groupByProvider`; new `filterThreadProviderGroups`), `apps/mobile/src/lib/modelOptions.test.ts` (create if absent), `apps/mobile/src/features/threads/ThreadComposer.tsx` (~:476-490).

- [ ] Step 1: Tests first, in `modelOptions.test.ts`, for a pure `filterThreadProviderGroups(groups, providers, current: { instanceId, driver })` (signature up to you; keep it pure and data-in/data-out): (a) two claude instances with equal `continuation.groupKey` → both groups offered; (b) equal driver, one key `undefined` → only the current group; (c) two antigravity instances with keys missing → only the current; (d) current instance absent from `providers` (disabled) → its group is still returned. Run `cd apps/mobile && pnpm exec vp test run src/lib/modelOptions.test.ts` → fails (no export).
- [ ] Step 2: Add `continuationGroupKey: string | null` to `ModelOption` (from `provider.continuation?.groupKey ?? null`) and to `ProviderGroup` (from its first option). Implement `filterThreadProviderGroups` as web's predicate (`apps/web/src/components/ChatView.logic.ts:343-357`): keep a group when it is the current group, or when `group.providerDriver === current.driver` and both keys are non-null and equal, and (Antigravity) when the current key is null, only the exact instance. Run → green.
- [ ] Step 3: In `ThreadComposer.tsx` replace the `providerKey === currentModelSelection.instanceId` filter with the helper, resolving the current instance as `props.session?.providerInstanceId ?? currentModelSelection.instanceId` if a session is reachable in that component (check its props; if not, keep `currentModelSelection.instanceId` and say so). Update the comment: "An existing thread can move only within its continuation group…". Run `cd apps/mobile && pnpm exec vp test run src/features/threads && pnpm run typecheck` → green.
- [ ] Step 4: Commit `feat(mobile): offer the thread's whole continuation group in the picker`.

### Task 5: Docs

**Files:** Modify `docs/user/providers-claude.md` (§ "Can I Switch Claude Accounts In An Existing Thread?" ~:135-144), `docs/fork/README.md` (new numbered entry after the last one).

- [ ] Step 1: Rewrite the section: yes, when both Claude providers' config directories share one `projects` directory (for example `~/.claude-personal/projects` as a symlink to `~/.claude/projects`); T3 Code keys "same Claude environment" on that directory, because it is where Claude Code keeps the conversation transcripts `--resume` reads. Otherwise no: a separate config directory has its own transcripts, and the thread would lose its history. Keep the Codex contrast paragraph, corrected to "Codex shares its home directly; Claude shares through the projects link".
- [ ] Step 2: Registry entry "### 28. Claude's continuation group is the transcript store": upstream keys on HOME only, the fork keys on `realpath(<configDir>/projects)`; the persisted cursor follows across equal keys (`ProviderService.startSession`); mobile filters by group; a reconcile that restores a HOME- or config-dir-string key silently re-refuses the switch, and one that restores the id-only cursor inheritance silently loses history on a stopped-session switch.
- [ ] Step 3: `pnpm exec vp fmt` both; commit `docs: switching Claude accounts in an existing thread`.

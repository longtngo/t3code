# Per-instance OAuth usage credentials — 2026-06-05

## Goal

The footer usage readout (5h / 7d / extra) must reflect the subscription of the
**active thread's provider instance**. Today, with two Claude instances bound to
different accounts (e.g. "UniSub" and "PersonalSub" via distinct `configDirPath`
values), every instance reports the same account's usage — whichever account the
_base_ process environment resolves to.

## Root cause

`makeClaudeAdapter` builds a per-instance environment (`claudeEnvironment`) via
`makeClaudeEnvironment`, which overlays `HOME` (from `homePath`) and
sets/scrubs `CLAUDE_CONFIG_DIR` (from `configDirPath`). Spawned sessions use it
(the `env` handed to the SDK query options), so prompts run under the correct
account.

The account-usage poller did **not**: it was constructed with
`env: options?.environment ?? process.env` — the pre-overlay base env. `resolveOAuthToken` (OAuthUsage.ts) salts the macOS
Keychain service name by `env.CLAUDE_CONFIG_DIR` and locates the credentials
file under `claudeConfigDir(env)`; with the base env it always resolves the
default account's token, so every adapter broadcasts that account's usage to
all of its threads. The web client is not at fault — usage events are emitted
per-thread and the UI derives the snapshot from the active thread's activities.

Secondary gap: `claudeConfigDir` falls back to `${homedir()}/.claude`, ignoring
`env.HOME`. Fix #1 introduces a per-instance `env.HOME` (overlaid by
`makeClaudeEnvironment` when `homePath` is set) that the poller's
credentials-file path would then ignore — `homedir()` reads the _server
process's_ home. The spawned CLI resolves its home from `env.HOME`; the poller
must match. (On POSIX, `homedir()` returns `$HOME` when set — even when set to
`""`, which is why `claudeConfigDir` length-guards `env.HOME` before falling
back — and the passwd home only when `$HOME` is unset. Blank-homePath instances
therefore see no behavior change. The fallback is meaningful primarily on
non-darwin / no-Keychain hosts, since darwin resolves via Keychain first.)

## Approach

1. `ClaudeAdapter.ts` (`makeClaudeAdapter`): pass `env: claudeEnvironment` to
   `makeAccountUsagePoll` (it is built earlier in the constructor and already
   incorporates `options?.environment` as its base).
2. `OAuthUsage.ts` `claudeConfigDir`: fall back to the instance home —
   `env.HOME` when set and non-empty (length-guarded, matching the existing
   `CLAUDE_CONFIG_DIR` check; a bare `??` would turn `HOME=""` into
   `"/.claude/.credentials.json"`), else `homedir()` — so the credentials-file path
   follows the instance's home, mirroring how the spawned CLI resolves it.
3. Tests — all in `OAuthUsage.test.ts` against `resolveOAuthToken` (the unit
   the wiring feeds; an adapter-level test would need a real spawner +
   filesystem + HTTP stack and would over-mock):
   - Two envs with different `CLAUDE_CONFIG_DIR` values resolve different
     tokens from their own credentials files.
   - `env.HOME` is honored for the credentials-file path when
     `CLAUDE_CONFIG_DIR` is unset; empty-string `HOME` falls back to
     `homedir()`.
   - The Keychain lookup salts the service name by `CLAUDE_CONFIG_DIR`
     (observable via a fake spawner capturing `security -s <service>` args) —
     regression coverage for pre-existing behavior the fix depends on.
   - Existing adapter usage test injects `pollAccountUsage`, so it is
     unaffected.

## Alternatives considered

- **Resolve the token in `ClaudeDriver` and inject it** — rejected: extra
  plumbing across layers, and tokens rotate (the poll must re-resolve each
  tick, so it needs the env, not a frozen token).
- **Derive the env inside `OAuthUsage` from `ClaudeSettings`** — rejected:
  couples the generic OAuth module to the Claude settings schema;
  `makeClaudeEnvironment` already owns that mapping.

## Files touched

- `apps/server/src/provider/Layers/ClaudeAdapter.ts` (1 line)
- `apps/server/src/provider/Layers/OAuthUsage.ts` (claudeConfigDir fallback)
- `apps/server/src/provider/Layers/OAuthUsage.test.ts` (new resolution tests)

## Tradeoffs / limitations

- Two instances differing **only by `homePath`** on macOS still share one
  Keychain login (service salt comes from `CLAUDE_CONFIG_DIR` only) — that is
  the documented CLI behavior (`ClaudeHome.ts` comment), not something this fix
  changes.
- `CLAUDE_CODE_OAUTH_TOKEN` set in instance settings env already worked (it
  rides `options.environment`) and continues to take precedence.

## Follow-ups deferred

- None identified yet.

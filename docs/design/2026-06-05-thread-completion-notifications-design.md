# Thread-completion notifications — design

**Date:** 2026-06-05
**Status:** Proposed
**Branch (item 1):** `feat/thread-completion-notifications` (web + desktop)
**Follow-up (item 2):** `feat/mobile-completion-notifications` (mobile local)

## Goal

When an agent finishes a turn in a thread and the user is **not** already
looking at that thread, surface an OS-level notification so the user can return
to it:

- **Web (browser):** the W3C `Notification` API.
- **Desktop (Electron):** a native OS notification raised from the main process.
- **Mobile (Expo / React Native):** a local `expo-notifications` notification.

Clicking the notification focuses the app and navigates to the thread.

This is a **local, client-triggered** notification: the connected client
observes the completion in its own event stream and raises the notification
itself. It is distinct from — and complementary to — the existing
`apps/mobile/src/features/agent-awareness` system, which is **remote push**
(cloud relay → APNs, iOS-only) for when the app is backgrounded/closed.

## Background / current state (verified)

- **Completion signal.** A thread's derived UI truth is `thread.latestTurn.state`
  (`apps/web/src/store.ts`), which transitions `running → completed | error |
interrupted` when the assistant turn stops streaming. The orchestration event
  stream carries `thread.message.assistant.complete` and `thread.session-set`
  (session `status` leaving `running`, `activeTurnId → null`). The derived
  `latestTurn.state` transition is the most robust trigger because it is the
  same value the UI already trusts.
- **Web apply-site.** `apps/web/src/environments/runtime/service.ts:1037`
  (`applyEnvironmentOrchestrationEvents`) is the single choke point where event
  batches are folded into the zustand store via
  `useStore.getState().applyOrchestrationEvents(...)`. The existing
  `showActivityNotificationToasts(events)` call sits right here — the natural
  sibling for completion detection.
- **No OS-notification code exists** on web or desktop. (`new Notification`,
  `Notification.requestPermission` — zero hits outside mobile's push system.)
- **Desktop bridge.** Electron exposes `window.desktopBridge` (a
  `DesktopBridge` contract, `packages/contracts/src/ipc.ts:397`) via
  `contextBridge` in `apps/desktop/src/preload.ts`. Each capability is a channel
  in `apps/desktop/src/ipc/channels.ts`, a `makeIpcMethod({channel, payload,
result, handler})` in `apps/desktop/src/ipc/methods/*.ts`, wired in
  `DesktopIpcHandlers.ts`. `confirm`, `setTheme`, `openExternal`,
  `showContextMenu` are simple request/response templates; `onMenuAction` /
  `onCloudAuthCallback` are the main→renderer push template.
- **Platform gate.** `apps/web/src/env.ts` exports `isElectron` (true when
  `window.desktopBridge` is present). The same `apps/web` React bundle runs in
  both the browser and the Electron renderer.
- **Client settings.** `ClientSettingsSchema` (Effect Schema,
  `packages/contracts/src/settings.ts:42`) is the local-only settings struct
  (localStorage on web, IPC on desktop). `useSettings(selector)` /
  `useUpdateSettings()` (`apps/web/src/hooks/useSettings.ts`) read/write it;
  adding a boolean field gives persistence + a settings control for free.
- **Mobile** already depends on `expo-notifications` and has reusable
  permission (`notificationPermissions.ts`), deep-link payload parsing
  (`notificationPayload.ts`), and tap-navigation
  (`notificationNavigation.ts`) plumbing under `features/agent-awareness`.

## Approach

Two layers (detection inlined in web for item 1; see Design-review revisions):

```
┌──────────────────────────────────────────────────────────────────┐
│ web completion observer  apps/web/.../service.ts                   │
│   diff prev/next thread turn-state around the LIVE EVENT apply only │
│   → turns that transitioned running → completed|error|interrupted   │
│   + setting gate + dedup(threadId:turnId) + focus/route suppression │
└───────────────────────────────┬────────────────────────────────────┘
                                 │ notifyThreadCompleted()
┌───────────────────────────────▼────────────────────────────────────┐
│ web Notifier  apps/web/src/lib/notifier.ts                          │
│   browser : window.Notification (guarded)                           │
│   electron: window.desktopBridge.showNotification (feature-detected) │
└─────────────────────────────────────────────────────────────────────┘

(mobile, item 2 follow-up: its own observer at the mobile ingestion point
 + an expo-notifications local notifier, reusing agent-awareness payload +
 navigation. Detection is re-implemented for mobile's thread shape, or a
 shared helper is extracted then if the shapes prove to overlap.)
```

### 1. Web completion detection — inline in `apps/web/.../service.ts`

> **Why inline, not a shared `client-runtime` core (design-review revision).**
> Web's denormalized zustand store (`threadShellById` / `threadTurnStateById` /
> `sidebarThreadSummaryById`) and mobile's `ThreadDetailState` are different
> shapes; a "shared core" would be a thin per-platform adapter over ~15 lines of
> transition logic. We keep detection inline in web now and extract only if the
> mobile follow-up proves real overlap. Matches AGENTS.md "extract when shared".

Detection is a per-thread transition check: a turn fires exactly when the
thread's latest turn was `running` and is now terminal (`completed | error |
interrupted`). `classifyThreadCompletion(prevState, nextTurnId, nextState)`
returns the completion descriptor or `null`.

> **Hook the shell-stream `thread-upserted` EVENT, not the orchestration-events
> path (implementation correction to the original plan).** Tracing the streams
> showed that `applyOrchestrationEvents` (service.ts ~line 1053) is fed by the
> **per-thread detail subscription** (`subscribeThread` →
> `applyEnvironmentThreadDetailEvent` → `applyRecoveredEventBatch`), so it only
> covers threads with an **active detail subscription** — i.e. essentially the
> thread you are viewing, which we suppress anyway. The authoritative
> `latestTurn` for **every** thread (including background ones) arrives on the
> **shell stream** as `thread-upserted` events handled by `applyShellEvent`
> (`apps/web/src/environments/runtime/service.ts`). That is therefore the
> correct and sufficient single hook; hooking the orchestration path would have
> notified almost nothing.
>
> `applyShellEvent` already captures `previousThread` (via `selectThreadByRef`)
> **before** mutating the store, and the event carries the new
> `event.thread.latestTurn`, so the running → terminal edge is read directly with
> no map projection. Stale/replayed shell events are gated upstream by
> `shouldApplyProjectionEvent` (sequence ordering); snapshot rehydration
> (`syncServerShellSnapshot`) is a **separate** path and is deliberately NOT
> hooked, so reconnect hydration of already-finished threads never fires.

```ts
// inside applyShellEvent's "thread-upserted" case, after the store mutation:
notifyThreadCompletionFromShellEvent(environmentId, previousThread, event.thread);

// helper:
const completion = classifyThreadCompletion({
  threadId: nextThread.id,
  previousState: previousThread?.latestTurn?.state ?? null,
  nextTurnId: nextThread.latestTurn?.turnId ?? null,
  nextState: nextThread.latestTurn?.state ?? null,
  title: nextThread.title,
});
if (completion) {
  notifyThreadCompletions({
    environmentId,
    completions: [completion],
    enabled: getClientSettings().notifyOnThreadCompletion,
  });
}
```

### 2. Web completion gate — `maybeNotifyThreadCompletion`

Applies, in order:

1. **Setting gate** — `notifyOnThreadCompletion` client setting is on.
2. **Dedup** — a bounded `Set<\`${threadId}:${turnId}\`>`(same pattern as`shownNotificationActivityIds`, cap ~500) guards against any double-fire.
3. **Suppression** — skip when the user is already watching this thread:
   `document.visibilityState === "visible"` **and** `document.hasFocus()`
   **and** the active route's threadId equals the completed threadId. (Active
   thread read from the router; see Open questions.)
4. Dispatch to the **web Notifier**.

### 3. Web Notifier — `apps/web/src/lib/notifier.ts`

```ts
notifyThreadCompleted(input: {
  title: string; body: string; threadRef: ScopedThreadRef;
}): void
```

- **Electron branch (`isElectron` + feature-detect):** when
  `typeof window.desktopBridge?.showNotification === "function"`, call
  `window.desktopBridge.showNotification({ title, body, threadRef })`. No browser
  permission needed; the main process owns presentation and click handling. The
  feature-detect guard is required so a **new web bundle served to an old
  Electron shell** (during rollout) no-ops instead of throwing
  `showNotification is not a function` (pattern: `Sidebar.tsx` `onUpdateState`,
  `AppSidebarLayout.tsx` `onMenuAction`).
- **Browser branch:** guard `typeof Notification !== "undefined"`; if
  `Notification.permission === "granted"`, construct
  `new Notification(title, { body, tag: threadId })` (tag coalesces repeats per
  thread). `onclick` focuses the window and routes to the thread **via the
  TanStack router** — `navigate({ to: "/$environmentId/$threadId", params })`
  built with the existing `buildThreadRouteParams` (`apps/web/src/threadRoutes.ts`),
  NOT a literal path string (web routes by params, not mobile's
  `/threads/...`). If permission is not granted, no-op (enabling the setting is
  what requests permission — see §5).

`threadRef` is the structured `{ environmentId, threadId }`; both branches route
through the same `buildThreadRouteParams` helper. No stringified deep-link on web.

### 4. Desktop native notification — `apps/desktop`

New IPC capability mirroring `openExternal` (design-review revision: **no
separate `ElectronNotification` service**; inline like `openExternal`):

- **Contract:** add to `DesktopBridge`
  `showNotification(input: DesktopNotificationInput) => Promise<void>` and
  `onNotificationActivated(listener) => () => void`, plus a
  `DesktopNotificationInputSchema` ({ `title`, `body`, `threadRef:
{environmentId, threadId}` }) in `packages/contracts/src/ipc.ts`.
- **Channel:** `desktop:show-notification` and `desktop:notification-activated`
  in `ipc/channels.ts`.
- **Method (inline):** `showNotification` in a new `ipc/methods/notifications.ts`
  (wired in `DesktopIpcHandlers.ts`; added to `preload.ts`). The handler guards
  `Notification.isSupported()`, constructs Electron's `Notification`, and on
  `click` focuses the main window (`ElectronWindow.focusedMainOrFirst`) and
  pushes the activation to the renderer. ~15 lines; no service wrapper.
- **Click → navigate (reuse existing pattern):** mirror `onCloudAuthCallback` /
  `onMenuAction` exactly — `electronWindow.sendAll(NOTIFICATION_ACTIVATED_CHANNEL,
threadRef)`; preload exposes `onNotificationActivated(listener)` (copy of the
  `onCloudAuthCallback` wrapper); a small web hook
  (`useNotificationActivation.ts`) subscribes — **guarded with
  `typeof ...onNotificationActivated === "function"`** — and routes via
  `buildThreadRouteParams`. The IPC payload is the structured `threadRef`, not a
  path string, so web and desktop share one routing helper.

### 5. Settings + permission UX

- Add `notifyOnThreadCompletion: Schema.Boolean` (decoding default **false**)
  to `ClientSettingsSchema`, and `notifyOnThreadCompletion:
Schema.optionalKey(Schema.Boolean)` to `ClientSettingsPatch`
  (`packages/contracts/src/settings.ts:490`). The decoding default makes old
  persisted localStorage payloads lacking the key decode cleanly (backward
  compatible, verified — same pattern as `autoOpenPlanSidebar`).
- Settings UI: a toggle "Notify me when a task finishes" in the existing
  settings route(s).
- **Permission is gesture-bound.** Browsers only allow
  `Notification.requestPermission()` from a user gesture, so we cannot silently
  enable on load. Therefore the preference defaults **off**, and **turning the
  toggle on** (a gesture) triggers the platform permission request:
  - browser: `Notification.requestPermission()`; if denied, surface inline help
    and leave the toggle off.
  - electron: no browser permission needed — flipping the flag is enough (OS
    may still gate at the system level, which the user controls).
  - mobile: `requestAgentNotificationPermission` (existing helper, extended off
    iOS-only if we want Android — see follow-up).

## Alternatives considered

- **Desktop via renderer `window.Notification` (no IPC).** Chromium in the
  Electron renderer can show OS notifications directly. **Rejected:** on macOS
  it ties presentation/identity to the renderer's notification permission and
  app-signing quirks, click→focus is harder (no main-process window handle),
  and it diverges from the established `desktopBridge` capability pattern. The
  main-process route is the Electron-recommended path and idiomatic here. Cost
  is one small IPC method — worth it for reliable click-to-focus.
- **Server/relay-driven notification (extend agent-awareness to web/desktop).**
  **Rejected for this feature:** that system is remote push for
  backgrounded/closed clients and requires cloud sign-in + the relay. The ask
  is a local notification from a _connected_ client, which it already has the
  signal for. The two are complementary, not substitutes.
- **Trigger on a raw event type (`thread.message.assistant.complete`) instead
  of a state transition.** **Rejected:** does not self-dedup across recovered
  batches and is noisier (proposed/streamed sub-states). The derived
  `latestTurn.state` transition is the UI's own definition of "done".
- **Notify unconditionally (no suppression).** **Rejected:** notifying for the
  thread the user is actively watching is pure noise; the universal convention
  is to suppress when focused on the target.

## Files touched (item 1: web + desktop)

- `packages/contracts/src/settings.ts` — `notifyOnThreadCompletion` field + patch.
- `packages/contracts/src/ipc.ts` — `DesktopNotificationInput`,
  `showNotification`, `onNotificationActivated` on `DesktopBridge`.
- `apps/web/src/lib/notifier.ts` (+ test) — web Notifier (browser + electron
  branches) + inline completion detection helper + suppression + dedup.
- `apps/web/src/environments/runtime/service.ts` — observe completions around the
  live event applies (orchestration + detail-stream events; NOT snapshots).
- `apps/web/src/hooks/useNotificationActivation.ts` — desktop click→route hook
  (guarded).
- `apps/web/src/routes/settings.tsx` (+ any mobile-web settings surface) —
  toggle + permission request.
- `apps/desktop/src/ipc/channels.ts`, `ipc/methods/notifications.ts`,
  `ipc/DesktopIpcHandlers.ts`, `preload.ts` — desktop capability (notification
  built inline in the method; no separate Electron service file).

## Files touched (item 2: mobile, follow-up)

- Mobile completion observer at its orchestration ingestion point
  (`apps/mobile/src/state/use-remote-environment-registry.ts` or the thread
  shell reducer), with a mobile-shaped transition check (re-implemented for
  `ThreadDetailState`, or extracting a shared helper at that point if the shapes
  overlap enough to justify it).
- `apps/mobile/.../agent-awareness/localCompletionNotification.ts` — schedule a
  local `expo-notifications` notification with the existing deep-link payload;
  reuse `notificationNavigation` for tap routing.
- **Android enablement (design-review blocker for item 2):**
  `app.config.ts` does **not** currently list the `expo-notifications` plugin —
  add it (icon/color/sounds) so prebuild creates the default Android channel,
  else `scheduleNotificationAsync` fails on Android 8+ ("No notification channel
  found"). Add an explicit channel + a foreground presentation handler.
- **Permission is iOS-gated today** (`notificationPermissions.ts` returns
  `unsupported` for non-iOS). Extend it to request on Android too for local
  notifications.
- Settings toggle on the mobile settings screen (already imports
  `expo-notifications`).

## Tradeoffs and known limitations

- **Permission is opt-in** (gesture requirement). The feature is dark until the
  user enables it. Acceptable and privacy-respecting; documented in settings.
- **Suppression uses window focus + active route**, not true per-thread scroll
  visibility. Good enough; matches conventions.
- **Mobile local notifications only fire while the app is foregrounded and
  connected.** Background/closed coverage remains the remote-push
  agent-awareness system. The two must not double-notify: local fires only when
  app is `active`; push targets background — naturally disjoint.
- **Desktop dev caveat:** native notifications may render with the dev app
  identity until packaged/signed; verify in a packaged smoke build.

## Follow-ups deferred

1. Mobile local completion notifications (item 2 — drained before release).
2. Optional: per-project / per-thread mute, and notification sound/badge
   preferences.
3. Optional: include richer body (first line of assistant summary) — start with
   provider + project + outcome.

## Open questions (resolved during planning)

- **Active-thread source on web.** Read the current threadId from the TanStack
  router match (the `_chat.$environmentId.$threadId` route) rather than store
  state, to avoid coupling suppression to store internals. Confirm a clean
  selector exists or add a tiny `getActiveThreadRef()` reading router state.

## Design-review resolution log (2026-06-05, 3 parallel reviewers)

Applied:

- **Snapshot false-positive storm / missed completions (Correctness, blocker).**
  Observe only the live **event** apply paths, never `syncServerShellSnapshot` /
  `syncServerThreadDetail` (wholesale rehydration). See §1.
- **Web route mismatch (Correctness, blocker).** Web navigates by TanStack
  params via `buildThreadRouteParams`; IPC carries structured `threadRef`, not
  mobile's `/threads/...` string. §3, §4.
- **Apply-site line label (Correctness, should-fix).** Detection wraps the apply
  at service.ts ~1053 (capture prev before, next after), not the toast call at
  ~1037.
- **Premature shared core (Simplicity, high).** Detection inlined in web for
  item 1; extract only if mobile proves overlap. §1.
- **Electron service over-engineered (Simplicity, medium).** Notification built
  inline in the IPC method; no `ElectronNotification.ts`. §4.
- **Reuse main→renderer push (Simplicity, medium).** Activation reuses the
  `onCloudAuthCallback`/`sendAll` pattern. §4.
- **Missing feature-detect + API guards (Compatibility, blocker).**
  `typeof desktopBridge?.showNotification === "function"`,
  `onNotificationActivated` guard, and `typeof Notification !== "undefined"`. §3.
- **`ClientSettingsPatch` field (Compatibility, minor).** Added. §5.
- **Android channel/plugin + iOS-only permission (Compatibility, blocker for
  item 2).** Captured in item-2 follow-up files.

Verified (no change): `latestTurn.state` set is exactly
`running|completed|error|interrupted`; transition trigger is self-deduping;
`withDecodingDefault` keeps old settings payloads backward compatible; initial
hydration does not flood (transition-based + suppression).

Exit: one review round; all findings triaged and applied. Small design
(<300 LOC item 1) → single round sufficient per the workflow.

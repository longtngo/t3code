# Low-Bandwidth Connection Support — Design

**Date:** 2026-07-05
**Status:** Design (pending implementation plan)
**Target scenario:** Mobile app over cellular / Tailscale — high latency, frequent reconnects, data-cap sensitivity.
**Outcome sought:** A prioritized, phased roadmap covering every bandwidth lever, shipped incrementally.

---

## 1. Problem

The prior "connection resilience" work (offline outbox, never-give-up reconnect, quiet UX, PWA
precache) solved *surviving disconnects*. It did **not** address *doing more with fewer bytes on a
slow-but-present link*. On mobile over cellular/Tailscale the pain is: (a) every reconnect re-downloads
full state, (b) background subscriptions stream continuously even when nobody is looking, and (c) all
traffic is uncompressed, verbose JSON.

## 2. Current state (grounded)

The client↔server link is a **single WebSocket** carrying **Effect RPC** as **plain JSON**
(`RpcSerialization.layerJson`), identical across web, Electron desktop, and React-Native mobile.
Key facts, from code:

- **No compression anywhere.** No `permessage-deflate` on the socket; no gzip/brotli on HTTP.
  Serialization is JSON on both ends (`packages/client-runtime/src/wsRpcProtocol.ts:296`,
  `apps/server/src/ws.ts:1577`).
- **Full-snapshot re-sends on every reconnect.** `subscribeThread` /`subscribeShell` prepend a full
  snapshot to the live stream (`apps/server/src/ws.ts:960-1016`, `909-945`); the client fully replaces
  its copy on each (re)subscribe (`packages/client-runtime/src/threadDetailReducer.ts` /
  `apps/web/src/environments/runtime/service.ts:411-412`).
- **A dormant incremental-replay path already exists.** `orchestration.replayEvents(fromSequenceExclusive)`
  is in the contract and has a server handler (`apps/server/src/ws.ts:886-908`) plus a full client
  recovery state machine (`apps/web/src/orchestrationRecovery.ts`) — but it is **not wired into
  `WsRpcClient`** and is referenced only by tests. Production reconnect relies on full snapshots.
- **Continuous background subscriptions.** `host-metrics` streams every ~1.5s
  (`apps/server/src/ws.ts:1500`), `llm-models` every ~4s (`ws.ts:1506`), regardless of tab visibility
  or app foreground state.
- **Streaming deltas are already well-handled.** Default "buffered" mode
  (`enableAssistantStreaming:false`, `packages/contracts/src/settings.ts:502`) collapses per-token
  frames into ~one frame per message (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1751-1797`).
  **But** tool/reasoning `thread.activity-appended` frames are **not** buffered — one frame each.
- **Attachments** upload over the socket as **base64, up to ~27MB in a single frame**, no chunking
  (`packages/contracts/src/attachment.ts:8-20`).

**Runtime note:** the server runs under **Node in production** (`node dist/bin.mjs`) with an optional
Bun path, both via Effect's platform WS abstraction (`apps/server/src/server.ts:120-133`). Transport-level
`permessage-deflate` is therefore not a guaranteed config flag.

**Validated premises (probed 2026-07-05):**
- `effect/unstable/rpc` `RpcSerialization` exports `layerMsgPack` in this version (`effect@4.0.0-beta.78`).
- `RpcSerialization` has **no** built-in deflate/compression layer — the compression half is custom.

## 3. Design principle: two tiers, not one big "mode"

Most of these wins are **strictly better for everyone** — no user wants *more* bytes — so we do **not**
build a heavyweight "Low-Bandwidth Mode" framework (YAGNI). The design splits into:

- **Tier A — always-on wins** (ship unconditionally, on by default for everyone, no detection):
  compression, incremental reconnect sync, pause-when-hidden, activity batching, the metrics-cadence ramp.
- **Tier B — a thin adaptive layer** (only the one knob with a real quality tradeoff): how aggressively an
  uploaded image is downscaled, where a *fast* link has a legitimate reason to prefer fidelity. A sensible
  compression default is on for everyone; auto-detect (RN NetInfo / `navigator.connection.saveData`) only
  *escalates* to a more aggressive tier when it measures a constrained link. **No manual toggle.**

The bandwidth savings are therefore **on by default** — Tier B is not a gate on the savings, only an
optional escalation of the one setting whose aggressive form costs quality on a good connection. If
measurement shows even the aggressive image default is acceptable universally, Tier B collapses to nearly
nothing.

Every phase is gated by a **measurement** so each win is proven, not assumed.

## 4. Phased roadmap

| Phase | What | Why it wins on cellular/Tailscale | Cost | Risk |
|---|---|---|---|---|
| **0. Measure** | Dev-only per-frame byte/count logger + a scripted byte-budget scenario (reconnect ×N, 10-min idle, one agentic turn). | Baseline so every later phase is verifiable. | S | none |
| **1. Compression (MsgPack + deflate)** | Switch serialization JSON→MsgPack on both ends; add a custom deflate wrapper over frames above a size threshold; negotiate format at the `/ws` handshake. | Global 70–90% cut on all traffic; WireGuard/Tailscale doesn't compress, so this is the only compression. Binary also removes base64 attachment overhead. | M | med (both-ends cutover) |
| **2. Quiet background subs + cadence ramp** | Pause `host-metrics` + `llm-models` on tab-hidden / RN app-background; progressive `host-metrics` ramp 1.5s→5s over a live connection, reset on foreground/interaction. | Kills continuous idle drain — hours of a backgrounded phone currently still stream metrics; the ramp relaxes the foreground cost too. | S | low |
| **3. Incremental reconnect sync** | Wire the dormant `replayEvents` into `WsRpcClient`; on reconnect replay events since last-seen sequence; full snapshot only on gap / first load. | The signature cellular win — stops re-downloading the whole thread on every reconnect. | M | med (correctness; scaffolding exists) |
| **4. Activity batching** | Buffer `thread.activity-appended` frames like assistant text already is. | Long agentic turns emit one frame per tool step; batching cuts frame count on the active path. | M | low |
| **5. Attachment relief** | Client-side image pre-compress/resize before upload; carry bytes natively via MsgPack (base64 overhead already gone from Phase 1). | A phone photo is ~27MB base64 in one frame today — brutal on cellular uplink. | M | med |
| **6. Adaptive escalation (Tier B)** | RN NetInfo / `navigator.connection.saveData` auto-detect → escalate to a more aggressive image-downscale tier on a measured-constrained link. On by default; no manual toggle. | Squeezes the one quality-tradeoff knob further when the link truly warrants it. | S | low |

**Committed core:** Phases **1–5**. **Phase 6** is optional follow-on (and may collapse to near-nothing if
the aggressive image default proves universally acceptable — see §3).

## 5. Phase detail

### Phase 0 — Measurement harness
- A dev-only instrument that counts frames and sums bytes per RPC method / subscription, on both client
  and server. Purpose-built and minimal (note: the older request-telemetry seams were deliberately
  retired in `ee12b1a5a`; don't resurrect that — add a small, scoped counter).
- A repeatable scenario script producing a byte budget for: N reconnects on one open thread; 10 minutes
  idle with the app backgrounded; one representative agentic turn (several tool calls + a long message).
- **Gate:** baseline numbers recorded before Phase 1; re-run after each phase to quantify the delta.

#### Recorded baseline (2026-07-05, `node scripts/wire-budget.ts`)

Current JSON transport, with a JSON+deflate column showing the headroom per-message deflate
alone would recover (only applied above the ~1KB threshold):

| Frame | JSON | JSON+deflate |
|---|---|---|
| host-metrics sample | 285 B | 285 B (—) |
| llm-models sample | 440 B | 440 B (—) |
| activity-appended (tool step) | 673 B | 673 B (—) |
| activity-appended (assistant message) | 2.7 KB | 327 B (−88%) |
| thread snapshot (24 activities) | 7.6 KB | 703 B (−91%) |
| attachment upload (~768 KB photo) | 1.00 MB | 758 KB (−26%) |

| Scenario | JSON | JSON+deflate |
|---|---|---|
| 10× reconnect on one thread | 75.5 KB | 6.9 KB (−91%) |
| 10-min backgrounded idle | 175.8 KB | 175.8 KB (−0%) |
| agentic turn (12 tool steps) | 10.6 KB | 8.2 KB (−23%) |

**Baseline findings that shape the later phases:**
1. **Idle drain is immune to compression.** The 10-min backgrounded idle budget (175.8 KB) gets
   *zero* benefit from deflate because every host-metrics/llm-models frame is under the 1 KB
   threshold. Only **Phase 2** (pause when hidden) removes this cost — it does not overlap with
   Phase 1 at all.
2. **Reconnect and large frames compress 88–91%.** Phase 1's deflate is decisive for the snapshot
   and long-message frames; **Phase 3** (incremental replay) then removes the reconnect re-download
   entirely rather than just compressing it.
3. **A base64 photo only deflates ~26%** (it recovers base64's 33% overhead, no more — a real JPEG
   is already compressed). So **Phase 1** (binary via MsgPack, dropping base64) plus **Phase 5**
   (client-side resize) are the real levers for attachments, not compression of the base64 blob.

The live wire meter (`globalThis.__t3WireMeter` on the client; `T3CODE_WIRE_METER=1` per-method on
the server) validates these modelled numbers against the real app when running end-to-end.

### Phase 1 — Compression: MsgPack + deflate (both)
- **MsgPack:** replace `RpcSerialization.layerJson` with `layerMsgPack` at both ends
  (`wsRpcProtocol.ts:296`, `ws.ts:1577`). Confirmed available in `effect@4.0.0-beta.78`.
- **deflate:** add a custom compression wrapper (no built-in layer exists) that deflates encoded frames
  **only above a size threshold** (~1KB) — small frames like `Pong` gain nothing and pay ~11 bytes of
  deflate overhead. Stateless per-message deflate (no context takeover) for simplicity.
- **Handshake negotiation (required):** a binary wire format is a *hard* break on version skew — a stale
  client can't deserialize at all. The server serves the web/desktop bundle (always lockstep), but the RN
  **mobile app deploys separately** and can lag. So the client advertises supported formats at the `/ws`
  handshake (subprotocol or query param) and the server falls back to JSON for clients that don't advertise
  MsgPack. This makes the rollout safe and reversible.
- **Attachment synergy:** MsgPack carries `Uint8Array` natively, so the attachment contract can drop base64
  (33% overhead) — part of Phase 5 lands here for free.
- **Risk/mitigation:** both-ends protocol bug across web/desktop/mobile → covered by negotiation +
  round-trip tests across all three clients; deflate CPU/battery cost on mobile → mitigated by the size
  threshold and by Phase 3 shrinking the large snapshots that would cost the most to compress.

#### Phase 1 implementation notes (2026-07-05, shipped)

- **Codec:** a custom `RpcSerialization` (`@t3tools/shared/rpcSerialization`) using `msgpackr`
  (`useRecords: true`) + `fflate` — the *same* deflate lib on both ends, so there is no cross-library
  compatibility surface. Because deflated payloads aren't self-delimiting (unlike raw msgpack), the
  serialization does its **own length-prefixed framing**: `[flags:u8][len:u32-BE][payload]`, deflating
  only payloads above the 1 KB threshold (flag bit 0). Verified by unit tests (round-trip, multi-frame,
  split-chunk reassembly, record continuity, native binary) and a real RpcClient↔RpcServer socket
  round-trip test.
- **Handshake negotiation:** client-driven via a `?fmt=msgpack-deflate` query param; the server reads it
  (`HttpServerRequest.toURL`) and provides `layerCompressedMsgPack`, else falls back to
  `RpcSerialization.layerJson`. This protects the realistic skew direction (a lagging mobile client that
  doesn't advertise msgpack still gets JSON). The advertised format is a module-level setting
  (`setAdvertisedWireFormat`) defaulting to msgpack — also a JSON kill-switch.
- **Heartbeat:** the socket-level `Pong` sniff was a `JSON.parse` on the frame, which binary frames break.
  Replaced with "any inbound frame refreshes liveness" — format-agnostic, and equivalent because idle
  traffic is ping/pong only (esp. after Phase 2). Preserves `isHeartbeatFresh` (drives resume-reconnect).
- **Browser-test caveat:** the web browser suite mocks the socket with **msw, which only transports text
  frames** — it silently drops the client's binary msgpack. Those tests therefore force the JSON format
  (`setAdvertisedWireFormat("json")`); the msgpack path is covered instead by the Node RPC round-trip
  test and a browser-side codec round-trip test. This is a test-harness limitation, not a product gap.
- **Re-measurement** (`node scripts/wire-budget.ts`, MsgPack+deflate column, the real codec):
  thread snapshot 7.6 KB → **754 B (−90%)**; 10× reconnect 75.5 KB → **7.4 KB (−90%)**; 10-min idle
  175.8 KB → **145 KB (−17%)** (small frames dominate — Phase 2 is the real lever there); agentic turn
  10.6 KB → **7.3 KB (−32%)**. Small frames also shrink even without deflate (msgpack structure).

### Phase 2 — Quiet background subscriptions + cadence ramp
- Client unsubscribes / pauses `host-metrics` and `llm-models` on `visibilitychange` hidden (web/desktop)
  and RN `AppState` background (mobile), resuming on foreground (reuse the existing app-resume reconnect
  hooks, `apps/mobile/src/state/use-remote-environment-registry.ts:462-520`).
- **Progressive cadence ramp (on by default, all platforms):** `host-metrics` starts responsive at 1.5s
  and slowly relaxes the interval toward a 5s ceiling over a long-lived foreground connection; any
  foreground/interaction event (or panel focus) resets it to 1.5s. A phone rarely needs sub-second
  server-CPU updates for long, but the first look should still feel live.
- **Gate:** Phase-0 "10-min backgrounded idle" byte budget drops to ~zero for these streams; the foreground
  idle budget drops as the interval ramps to 5s.

#### Phase 2 implementation notes (2026-07-05, shipped)

**Verified before building (the premise was mostly already true):**
- **Pause-when-hidden is already shipped.** `useHostMetrics`, `useLlmModels`, and `useResourceQueue` on
  web/desktop each tear their subscription down on `document.hidden` (each carries a "Pause … while the tab
  is hidden so a backgrounded window costs nothing" comment) and re-establish on visible. So the primary
  Phase 2 gate — the 10-min backgrounded-idle budget dropping to ~zero — was **already met**; unsubscribing
  stops the server-side sampling entirely.
- **Mobile does not stream these at all.** `apps/mobile` has no host-metrics / llm-models subscription, so
  the "backgrounded phone still streams metrics" concern is moot for the actual low-bandwidth target.

**What was actually built — the foreground cadence ramp (server-side):** `hostMetricsStream` now starts at
the requested/fast interval (1.5s "feels live" first look) and relaxes toward a 5s ceiling by +500ms per
tick (`rampSampleInterval`). Because the client already tears the stream down when the tab hides and
resubscribes fresh when it shows, **returning to the tab is the ramp reset** — no client API change, no
timers, no interaction plumbing. This is the whole remaining committed Phase 2 work; it benefits web/desktop
foreground-idle (a web client on a metered link), since mobile doesn't stream metrics.

**Deferred (follow-up):** resetting the ramp on in-tab *interaction* (vs. only on tab re-show) would need
client-side interaction tracking + per-subscription `intervalMs` plumbing; low value for the modest saving,
so deferred.

### Phase 3 — Incremental reconnect sync
- Add `replayEvents` to the `WsRpcClient` orchestration interface (`packages/client-runtime/src/wsRpcClient.ts`),
  mapping to the existing server handler (`ws.ts:886-908`).
- On reconnect: attempt replay from the last-seen sequence; fall back to a full snapshot only on a
  sequence gap or first load. Reuse the existing gap-detection/backoff in `apps/web/src/orchestrationRecovery.ts`.
- Apply the same pattern to `subscribeShell` where a sequence cursor exists.
- **Risk/mitigation:** correctness of gap handling / compaction → the dormant recovery code already models
  this and is exercised by tests; add reconnect-with-gap and reconnect-clean cases to the byte-budget
  scenario.
- **Gate:** Phase-0 "N reconnects" byte budget drops from ~N×full-thread to ~N×(events-since-cursor).

#### Phase 3 implementation notes (2026-07-05, shipped)

**Data-driven scope note:** Phase 1's compression already cut the 10-reconnect budget 75.5 KB → 7.4 KB
(−90%). Phase 3's incremental resume takes the remaining ~754 B compressed snapshot per reconnect down
to ~events-since (typically a few hundred bytes) — a real but smaller marginal win than the spec's
uncompressed-JSON framing implied. It was still built in full (user-confirmed) for the architectural
benefit of not re-snapshotting on every blip.

**Design correction (an adversarial review caught a blocker in the first attempt).** The first cut
reused the dormant `orchestrationRecovery` coordinator, whose gap check assumes a *contiguous global*
event stream. But `subscribeThread` delivers a **filtered per-thread subset** of the global sequence
axis, so consecutive delivered events are almost never `latestSequence + 1` apart — the coordinator
would have fired "recover" (a full-snapshot resubscribe) on nearly every event, *increasing* bandwidth.
The corrected design drops the coordinator (it stays dormant) for a simple monotonic high-water mark.

**Mechanism (folds `readEvents` into `subscribeThread`):**
- **Contract:** `subscribeThread` input gains an optional `fromSequenceExclusive` cursor.
- **Server (`ws.ts`):** with the cursor, materialize the missed global events (`readEvents(cursor)`),
  and only serve incrementally when the window is small enough to be complete
  (`< RESUME_MAX_MISSED_EVENTS`, kept below the store's 1000 read cap); it then streams the missed
  *thread* events (filtered) with no snapshot. A larger/older window **falls back to a full snapshot**
  rather than silently dropping the tail past the read cap. No cursor → the existing snapshot path.
- **Client (`service.ts`):** each subscription tracks `lastAppliedSequence` (a monotonic high-water
  mark, persisted across reconnects). A reconnect resubscribes with `fromSequenceExclusive =
  lastAppliedSequence`. Events apply when `sequence > lastAppliedSequence` (which preserves order AND
  dedups the read/live overlap); there is deliberately **no contiguity/gap check** — the thread stream
  is sparse on the global axis, and completeness is the server's responsibility (stream-all-or-snapshot).
- **Removed** the now-dead `applyEnvironmentThreadDetailEvent` (superseded by the inline apply path).
- **Tests:** a wiring test proves fresh-subscribe carries no cursor, sparse events (6→9) apply WITHOUT
  a spurious resubscribe (the exact regression the review flagged), duplicates are ignored, and a
  reconnect resumes from the applied high-water sequence; existing subscribe/reconnect tests still pass.
- **Deferred (follow-ups):** (1) `subscribeShell` incremental resume — smaller per-reconnect and Phase 1
  already compresses it; (2) the server read-then-live concat has a small pre-existing lost-event window
  (an event committed after the read but published before the live subscribe) — it also exists in the
  snapshot path today, so this change is no worse; the lossless fix (subscribe-live-first, then read
  history, dedup) is a separate hardening for both paths; (3) the coordinator + its test are now fully
  dormant and could be removed.

### Phase 4 — Activity batching
- Extend the existing assistant-text buffering (`ProviderRuntimeIngestion.ts:1751-1797`) to coalesce
  `thread.activity-appended` frames within a turn, flushing on the same boundaries.
- **Gate:** frame count on the Phase-0 agentic-turn scenario drops materially.

#### Phase 4 implementation notes (2026-07-05, shipped)

**Data-driven scope note.** The spec framed this as extending the assistant-text buffering, but that
buffering already handles the big win — collapsing per-token *text deltas* into one message
(`bufferedAssistantTextByMessageId`). `thread.activity-appended` events are **discrete** domain events
(one per tool step / result / reasoning block via `runtimeEventToActivities`), not a token firehose, and
each append has load-bearing side effects (drives the sidebar shell refetch + background-task recording,
`ProviderRuntimeIngestion.ts` comment). So batching them at the *domain* level is both low-value (frame
overhead is ~a few % of a turn on a server→client push stream — content bytes are unchanged) and risky.

**What was built — safe wire-level batching (no domain-event change):**
- **Contract:** `OrchestrationThreadStreamItem` gains a `{ kind: "events", events: [...] }` batch variant.
- **Server (`ws.ts`):** the live thread-event stream is coalesced with `Stream.groupedWithin(64, 20ms)`
  and emitted as batch frames; a burst within a turn ships as one frame, isolated events flush after the
  20 ms window (imperceptible). The Phase 3 reconnect resume also now ships all missed events as **one**
  batch frame instead of N. Domain events are untouched — only the wire framing coalesces.
- **Client (`service.ts`):** applies a `single event` or an `events` batch identically — filter to the
  fresh events past the high-water mark (dedup), apply them in one store update, advance the mark.
- **Tests:** batch apply + dedup + reconnect-cursor-from-batch-max; existing subscribe/reconnect tests pass.

### Phase 5 — Attachment relief
- Client-side image resize/re-encode before upload (canvas on web/desktop, RN image API on mobile),
  with a sensible default quality/size cap.
- Base64→binary already handled by Phase 1's MsgPack switch.
- (Chunking is deferred unless the byte budget shows single-frame uploads are still a problem.)
- **Gate:** a representative phone-photo upload's on-wire size drops several-fold.

#### Phase 5 implementation notes (2026-07-05, shipped)

**What was built — client-side image downscale (web/desktop):** `apps/web/src/lib/imageResize.ts`
(`resizeImageForUpload`) decodes an image via `createImageBitmap`, caps the longest edge at 2048 px,
and re-encodes as JPEG (quality 0.85) on a canvas. It's wired into the composer upload
(`ChatComposer.tsx`) **before** the `ATTACHMENT_UPLOAD_MAX_BYTES` check, so a large photo that shrinks
under the 20 MB cap can now upload at all. Guards keep it safe: it returns the *original* file for
non-images, small images (< 512 KB), unsupported environments (no canvas), or when the re-encode would
not actually shrink it — so upload behavior never regresses. A phone photo (several MB to the 20 MB cap)
typically drops to a few hundred KB — ~90 %+ off, dwarfing every other lever — and it also cuts the
vision tokens the provider sees. Tests: pure dimension math + node passthrough cases, plus a real
in-browser canvas resize test.

**Deferred (follow-ups), each a deliberate data-driven scope cut:**
- **base64 → binary attachment field.** The spec assumed Phase 1's MsgPack made this free, but the RPC
  Schema layer sits *above* serialization and would still encode `Uint8Array` to a transport-safe value
  (and the browser-test JSON fallback can't carry raw bytes). After the resize the base64 33 % overhead
  is a few hundred KB — small next to the ~90 % the resize already saved — so it wasn't worth the
  Schema/JSON-fallback complexity here.
- **Mobile (React Native) resize** — the RN composer uploads via a separate path and needs a native
  image API (e.g. expo-image-manipulator), not canvas.
- **Inline (non-upload) image sends** — resizing images embedded directly in a message would also cut
  bytes + vision tokens, but touches more sites with vision-quality trade-offs.
- **Attachment chunking** — unnecessary once photos are resized to a few hundred KB.

### Phase 6 — Adaptive escalation (Tier B)
- Detect constrained links via RN NetInfo (cellular / low `effectiveType`) and `navigator.connection.saveData`.
- On a measured-constrained link, escalate to a more aggressive image-downscale tier (Phase 5). Everything
  else is already on by default and needs no detection.
- **On by default; no manual toggle.** Keep it thin — this is a small escalation, not a framework.
- May be dropped entirely if Phase-0/5 measurement shows the aggressive image default is acceptable for all.

## 6. Decisions made

- **Compression approach:** MsgPack **and** deflate (max byte reduction + native binary attachments),
  with handshake negotiation and a size threshold to de-risk and avoid pointless small-frame overhead.
- **On by default, no monolithic "mode":** every bandwidth saving ships always-on; the only adaptive
  element (Phase 6) escalates the single quality-tradeoff knob (image downscale) on constrained links, and
  even that is on by default with no manual toggle.
- **Phase 2 cadence:** `host-metrics` uses a progressive 1.5s→5s ramp (reset on interaction/foreground),
  not a fixed slow interval.
- **Committed scope:** Phases 1–5; Phase 6 is optional follow-on.

## 7. Out of scope (YAGNI)

- A general pluggable transport-negotiation framework beyond the one MsgPack/JSON fallback.
- SSE/long-poll fallback transports (prior work established these are useless over Tailscale — radio loss
  kills all transports equally).
- Attachment chunking (only if Phase-0/5 measurement proves single-frame uploads remain a problem).
- HTTP-side brotli/gzip for `/attachments` download and static assets (separate, smaller lever; revisit
  if the budget flags it).

## 8. Resolved during review (2026-07-05)

1. **Scope:** committed core is Phases **1–5** (activity batching and attachments are in); Phase 6 optional.
2. **Phase 2 cadence:** progressive **1.5s → 5s** ramp, reset on interaction/foreground — not a fixed slow
   interval.
3. **Adaptivity:** savings are **on by default**; auto-detect only escalates the aggressive image tier; **no
   manual toggle**.

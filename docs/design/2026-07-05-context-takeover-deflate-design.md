# Context-Takeover DEFLATE — a 3rd negotiated WebSocket wire format

Date: 2026-07-05
Branch: `feat/wire-context-takeover-deflate`
Status: design → review

> **SUPERSEDED (2026-07-09):** the v1 framing described below (`[tag][body]`, identifier
> `msgpack-deflate-stream`) desynced on multi-MB frames the transport re-chunked. It was
> replaced by **length-delimited framing** `[tag][uint32 BE len][body]` under a new identifier
> **`msgpack-deflate-stream-v2`** (so cached v1 clients cleanly downgrade instead of speaking v1
> framing into a v2 decoder). See the codec in `packages/shared/src/rpcSerialization/compressedMsgPack.ts`
> and `docs/reports` for the fix. Treat the wire-format details in this doc as historical.

## Goal
Add a stateful, context-takeover DEFLATE wire format to the client↔server WebSocket-RPC transport,
alongside today's `json` and per-frame `msgpack-deflate`. It keeps ONE persistent deflate window per
connection so each frame compresses against the frames before it — measured **−60% blended wire bytes**
on realistic thread-load traffic (−76% single-frame ceiling) vs today's stateless per-frame deflate, which
never warms its dictionary on the sub-1 KB frames that dominate the stream. Purely additive: `json` and
`msgpack-deflate` stay exactly as they are.

## Why this is safe to build now (measured this session)
- **Bytes:** −60% blended / −76% ceiling (`~/reports/t3code/2026-07/2026-07-05/2026-07-05-wire-compression-measurement.md`).
- **Mobile CPU gate cleared on real Hermes:** the mobile client only *inflates* (~35 ms once per thread-load,
  ~0.12 ms/frame steady-state on a conservatively-old Hermes VM); the expensive deflate runs server-side.
- **Dominated alternatives ruled out:** dictionary (16–28× CPU), msgpackr shared-structures (+9% only),
  columnar (no real batch surface), brotli/zstd (async → breaks `runSync`, no RN build). V1 is the one winner.

## Approach
A new serialization codec whose per-connection parser holds a persistent fflate streaming `Deflate`
(outbound) and `Inflate` (inbound):

- **Encode(message):** `packr.pack(message)` → `deflate.push(bytes, false)` → `deflate.flush()` → return the
  compressed bytes emitted since the previous flush. The `flush()` is mandatory — fflate buffers to ~8 KB
  without it (verified this session), which would stall small frames until enough accumulate.
- **Decode(chunk):** `inflate.push(chunk)` → append the inflated output to a running buffer → extract every
  **complete** MessagePack value (msgpack is self-delimiting) → return them, keep the trailing partial bytes.
  We do NOT rely on "one socket frame = one message": fflate's streaming `Inflate` holds bytes back across
  flush boundaries (verified this session), so boundaries are recovered from msgpack's own framing, not from
  inflate call boundaries.

No explicit length header (unlike `compressedMsgPack.ts`): the continuous deflate stream has no per-frame
compressed boundary, and post-inflation msgpack is self-delimiting, so the 5-byte header is unnecessary and
would be wrong here. `includesFraming: true` still holds — the codec owns its framing.

### Statefulness & reconnect — the load-bearing correctness point
The deflate window is order-dependent: dropping/reordering one frame desyncs the rest of the stream (proven
this session — one dropped frame → 0/N subsequent frames decode). This is safe because:
- Within one socket, TCP guarantees in-order, gapless delivery or the connection dies. No mid-stream loss.
- **Every reconnect builds a brand-new session** (`WsTransport.createSession` → new `ManagedRuntime` → new
  serialization layer → fresh `makeUnsafe()` → fresh `Deflate`/`Inflate`). So the window resets per socket
  **automatically** — there is no cross-socket window to desync, and no explicit reset wiring is required.
  A window is NEVER resumed across a gap.
Verified against live code: `wsTransport.ts:391-439` (per-session layer), `:337-357` (`reconnect()` →
`createSession`), `ws.ts:1687-1692` (per-connection `Layer.provideMerge(serializationLayer)`).

### Negotiation (extends FU1, unchanged safety model)
- New constant `WIRE_FORMAT_MSGPACK_DEFLATE_STREAM = "msgpack-deflate-stream"`, added to
  `SUPPORTED_WIRE_FORMATS` (so the server advertises it at `/ws/capabilities`).
- Client preference order becomes **stream → per-frame → json**. `advertisedWireFormat` default flips to the
  stream format; `negotiateWireFormat` picks the best format the server's advertised list ALSO contains
  (stream if present, else `msgpack-deflate`, else `json`). Every failure path still resolves to `json`
  (404 / network / CORS / timeout / no-fetch), and `setAdvertisedWireFormat("json")` stays the hard
  kill-switch that skips the probe (still what msw-based browser tests use).
- `?fmt=msgpack-deflate-stream` on the socket URL; server maps `?fmt` → the stream codec.
- **Old server, new client:** capabilities list lacks `stream` → client picks `msgpack-deflate` (or json). ✓
- **New server, old client:** client sends `?fmt=msgpack-deflate` or none → server picks that. ✓

## Files touched
- `packages/shared/src/rpcSerialization/compressedMsgPackStream.ts` (new) — the streaming codec +
  `WIRE_FORMAT_MSGPACK_DEFLATE_STREAM`, `layerCompressedMsgPackStream`, `makeCompressedMsgPackStreamSerialization`.
- `packages/shared/src/rpcSerialization/compressedMsgPack.ts` — add the new format to `SUPPORTED_WIRE_FORMATS`.
- `packages/shared/src/rpcSerialization/index.ts` — re-export the new symbols.
- `packages/client-runtime/src/wsRpcProtocol.ts` — extend `WsWireFormat`, `advertisedWireFormat` default,
  `negotiateWireFormat` (best-mutual), `resolveWsRpcSocketUrl` (`?fmt`), serialization selection.
- `apps/server/src/ws.ts` — 3-way `?fmt` → serialization selection + `wsConnectionsTotal` label.
- `apps/web/src/rpc/wsTransport.ts` — forward the new format through the protocol-layer override.
- Tests: codec unit (round-trip, context-takeover shrinks later frames, chunk-split decode, self-delimiting
  boundary recovery), negotiation (3-way best-mutual + all fallbacks), server capabilities lists stream,
  fresh-window-on-reconnect.

## Tradeoffs & limitations
- Codec is stateful/order-dependent (mitigated: fresh window per socket, TCP in-order-or-death).
- Steady-state mobile decode ~0.12 ms/frame; one-time thread-load decode ~35 ms on old Hermes (acceptable;
  optionally inflate incrementally-on-arrival to spread it — deferred, not needed for correctness).
- Slightly higher server encode CPU than per-frame deflate — server-side (Node), already measured fine.

## Follow-ups deferred
- Incremental-on-arrival inflate to spread the one-time load-decode cost (optimization, not correctness).
- Native WS ping/pong for idle (that is a separate item, V7 — not this change).
- Wire the FU2 `wsConnectionsTotal` split onto a dashboard (pre-existing follow-up).

## Review resolutions (Stage 6)

### From the simplicity review — ACCEPTED
- **Same-file codec.** Put the streaming codec IN `compressedMsgPack.ts`, not a new file. A separate file
  forces either duplicated buffer helpers (`toUint8Array`/`concat`/`EMPTY`) or a circular import via
  `SUPPORTED_WIRE_FORMATS` (top-level `const` array across an ESM cycle → TDZ/undefined at load). One cohesive
  ~250-line file has zero cross-file edges.
- **Keep all 3 formats; do NOT "replace under the same fmt name".** The fmt string names the on-wire framing;
  reusing `msgpack-deflate` for the streaming codec breaks an already-deployed old client mid-socket. Per-frame
  stays load-bearing during rollout. (Affirms the additive design.)
- **Explicit precedence, no generic helper.** Negotiation is data-driven by one ordered array, not a heavy
  `pickBestMutual` abstraction (see below). `resolveWsRpcSocketUrl` collapses to `if (format !== JSON) set(fmt, format)`.
- **No speculative knobs.** The sub-1 KB threshold is correctly NOT carried over (streaming compresses every frame).
- **Trim touch list:** `apps/web/src/rpc/wsTransport.ts` forwards `wireFormat` opaquely → likely no edit (verify).

### From the compatibility review — ACCEPTED (these are the implementation checklist)
- **Single source of truth for format→codec, to prevent skew.** Add a shared `serializationLayerForWireFormat(format)`
  in the rpcSerialization module used by BOTH the client (`wsRpcProtocol.ts:469`) and the server (`ws.ts:1675`).
  The `?fmt` param IS the format string, and both the URL and the codec read the one negotiated `wireFormat`, so
  they cannot disagree. Server `?fmt` selection becomes 3-way via this helper (a boolean today → BLOCKER: new/new
  would wedge).
- **Invert the client negotiate guard** to `if (advertisedWireFormat === WIRE_FORMAT_JSON) return json` (today's
  `!== msgpack-deflate` makes the flipped default inert → BLOCKER).
- **Client-precedence probe.** `CLIENT_WIRE_FORMAT_PREFERENCE = [stream, msgpack-deflate, json]`;
  `probeServerWireFormat` returns `preference.find((f) => serverFormats.includes(f)) ?? json` — picks by CLIENT
  precedence, never server list order. This is the anti-wedge gate: never emit `?fmt=stream` unless the probe saw
  `stream` in the server's list (old server → 404 or list without stream → downgrade to msgpack/json).
- **Per-`makeUnsafe` streaming objects.** The persistent `Deflate`/`Inflate` MUST live inside `makeUnsafe()`
  (per-connection), never in the factory closure — else one server process shares one deflate window across all
  connections and desyncs everyone. (`layer…` stays a `Layer.succeed` singleton *service*; the state is per-parser.)
- **Bounded leftover + partial-safe decode.** `unpackMultiple` THROWS on a trailing partial value, so decode must
  extract complete values with consumed-position tracking (try/catch or position API), keep the remainder, and cap
  the un-consumed inflated buffer at `MAX_FRAME_BYTES` (fail loud on a stream that never yields a complete value —
  preserves the per-frame codec's anti-unbounded-buffer invariant).
- **FU2 counter + docs:** emit `"msgpack-deflate-stream"` label (`ws.ts:1679`); extend the label-domain doc at
  `Metrics.ts:80`.
- **Rolling-deploy note (accept, no action):** `wireFormatByOrigin` pins the first probe per origin for the process
  lifetime — a client that probed a not-yet-upgraded replica stays on msgpack until restart. Missed upgrade, never
  a wedge. Acceptable.

### Tests to update / add (from compat review, exact anchors)
- BREAKS: `apps/server/src/server.test.ts:1294` capabilities `deepEqual([...].sort(), ["json","msgpack-deflate"])`
  → add `"msgpack-deflate-stream"`.
- State-leak: `packages/client-runtime/src/wsTransport.test.ts:140` + `apps/web/src/rpc/wsTransport.test.ts:150`
  `afterEach` restore the OLD default → restore the new default (or add `resetAdvertisedWireFormatToDefault()`).
- `WsWireFormat` union (`wsRpcProtocol.ts:91`) gains `"msgpack-deflate-stream"`.
- ADD: negotiation tests — advertised-stream + server-lists-stream → `?fmt=msgpack-deflate-stream`; advertised-stream
  + server-lists-only-msgpack → downgrade to `?fmt=msgpack-deflate`; + the codec unit tests already specced.
- ADD: stream-label assertion to the counter test (`server.test.ts:3911-3947`).

### Correctness review — a load-bearing premise was FALSIFIED (verified in Effect source)
**The "purely additive codec" premise is false.** Effect's `RpcClient.makeProtocolSocket` (verified in the
patched `effect@4.0.0-beta.78/.../RpcClient.ts`):
- `:1041` makes parser A; `:1043` encodes the heartbeat ping ONCE with it (`parser.encode(constPing)`), frozen;
  `:1178` `Effect.forever` resends those exact bytes every 5s — never re-encoded.
- `:1054` makes parser B (reassigns `parser`); `:1148` all DATA frames use parser B.
- Server has ONE `Inflate` (`RpcServer.ts:1454`) consuming both interleaved.
A stateful window can't survive this: two client Deflate streams into one server Inflate, plus a frozen ping
resent against an advanced window → SILENT desync (proven: mismatched inflate → 0 bytes, no throw) →
`Ping` never decodes → no `Pong` → ping-timeout → reconnect → re-desync → **permanent reconnect storm.**
Also flagged: (MAJOR) msgpackr partial-decode is exception-driven on undocumented fields
(`error.incomplete/.lastPosition/.values`) — must be spec'd + version-pinned; (MAJOR) outbound
encode-order must equal wire-send-order for concurrent sends — unproven, needs a mutex or a stress test;
(MAJOR) a mid-stream decode throw broadcasts an error WITHOUT tearing down the socket → must force
teardown-on-desync. Encode-emission, outer-reconnect reset, and inner-retry reset were all confirmed CORRECT.

### Revised approach — "Solution X": stateless control-frame markers over the stateful data stream
The fix that avoids forking Effect's protocol: a 1-byte frame-type tag.
- `encode(msg)`: if `msg._tag` is a control frame (`Ping`/`Pong`), emit `[MARKER] + rawMsgpack(msg)` —
  STATELESS, no deflate, does NOT touch the window. Else emit `[STREAM] + deflate.push+flush(msgpack(msg))`.
- `decode(frame)`: read the tag; `MARKER` → unpack raw, do NOT feed the Inflate; `STREAM` → feed the Inflate,
  extract complete msgpack values (self-delimiting), keep remainder (bounded).
Why this dissolves both blockers: parser A only ever encodes `constPing`, which is now STATELESS → parser A
never touches a window, so the frozen-ping is a valid constant forever, and there is effectively ONE stateful
stream (parser B ↔ server Inflate). Residual work still required: (1) a send-order guarantee for concurrent
DATA frames (verify Effect's write path preserves order, else serialize encode+send) — an EXPERIMENT;
(2) force socket teardown on any `STREAM` decode failure (no silent recovery); (3) the pinned exception-driven
msgpackr partial decode. This is MORE than "a codec + negotiation": it is a control-frame-aware codec plus a
send-order guarantee plus desync-teardown, in the reconnect-critical transport, with silent failure modes.

### Diff-review resolution (Stage 8) — all three concurrency findings closed with PUBLIC APIs

An adversarial diff review after the first build found three concurrency hazards the codec unit tests didn't
cover. Each was re-validated in the patched Effect source, then fixed — and the fixes needed **no fork of
Effect's private transport internals**, contrary to the initial estimate:

- **Finding 9 — server outbound send order (BLOCKER).** `RpcServer` runs handlers concurrently and the ws
  protocol's `send` encodes eagerly (`parser.encode` at call time) then defers the write, so two responses can
  encode in one order and write in another → the shared deflate window desyncs. **Fixed** with
  `withOrderedSend(protocol)` (`apps/server/src/wsRpcServerProtocol.ts`): wrap `send` in
  `sendMutex.withPermits(1)(Effect.suspend(() => protocol.send(...)))`. The `Effect.suspend` is load-bearing —
  it defers the eager encode INTO the permit so encode+write are atomic and ordered. Because
  `toHttpEffectWebsocket` is invoked once per `/ws` upgrade, one permit per connection suffices. Built from the
  exported `makeProtocolWithHttpEffectWebsocket` + `make` + `Protocol` — no private fork. Applied only to the
  stream format; JSON/per-frame keep the stock transport.

- **Finding 11 — client stale-window flush across a reconnect (REACHABLE).** Effect's ws `write`
  (`Socket.ts`) blocks on a shared open-latch and flushes to `currentWS`; an in-flight write straddling a
  disconnect would flush bytes encoded against the dying window to the NEXT socket (fresh window) → server
  inflate desync. **Fixed** with `abandonSendOnDisconnect(send, disconnectLatch)`: race each send against a
  disconnect latch wired to `ConnectionHooks`. Effect runs `onDisconnect` in the failure unwind *before* the
  retry re-opens the write latch, so the blocked send is interrupted (never flushes) deterministically.

- **Finding 10 — teardown-on-desync.** The codec now takes an `onDecodeDesync` callback, fired on a *detected*
  stream-decode failure; the client wires it to `socket.close(4000)` → reconnect with a fresh window. **Honest
  limit found while testing:** a desync is NOT reliably loud — a dropped mid-stream frame can decode to
  in-window garbage without throwing (fflate copies wrong bytes silently). So the codec cannot catch every
  desync, and this teardown is a best-effort backstop only. The real guarantee is **prevention**: ordered sends
  on both ends (Findings 9 + the pre-existing client `sendMutex`), the disconnect-race (Finding 11), TCP
  in-order-or-death, and a fresh window per socket. Server-inbound teardown is a documented residual —
  unreachable given the client-side prevention, and it would require forking the private read loop.

Each fix has a deterministic test (`withOrderedSend` ordering + a control test proving the suspend matters;
`abandonSendOnDisconnect`; codec desync-callback) plus an end-to-end integration test (24 concurrent requests
over one stream socket all round-trip through the real ordered wrapper).

### Finding 12 — pre-connect encode uses a throwaway deflate window (caught by the stress test)

The 24-concurrent-request integration test failed INTERMITTENTLY with fflate `invalid distance` — a deflate
desync on the SERVER's inflate (client→server). Root cause: Effect's `makeProtocolSocket` builds a stream
parser at setup and REASSIGNS a fresh one on connect (`parser = serialization.makeUnsafe()` inside the runRaw
suspend). A request encoded before that reassignment uses the pre-connect window; a later one uses the
post-connect window — two independent deflate streams into the server's single inflate. It is intermittent
(depends on whether a request encodes before or after connect) and real: any request fired during the initial
connect (a boot `serverGetConfig`, say) can hit it.

**Fix — a connect-gate.** The send wraps `connectedLatch.whenOpen(Effect.suspend(() => protocol.send(...)))`,
with `connectedLatch` opened by `ConnectionHooks.onConnect` (which fires AFTER the parser reassignment) and
closed by `onDisconnect`. So every DATA frame encodes against the live post-connect parser; the pre-connect
heartbeat ping is a stateless CONTROL frame and is harmless. Combined with the send mutex (ordering) and the
disconnect-race (Finding 11), the three latches make the client's outbound stream single-window and in-order
across the whole socket lifecycle. Proven: the concurrent integration test went from intermittent failure to
10/10 deterministic pass. Without the stress test this would have shipped as an intermittent boot-time desync.

## Standing decisions
Branch from `personal` HEAD; squash-merge to `personal`; **NO release** (stop after merge, unreleased, report).

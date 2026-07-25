import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/unstable/socket/Socket";

import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";

import { cryptoLayer } from "../features/cloud/dpop";
import { managedRelayClientLayer } from "../features/cloud/managedRelayLayer";
import { resolveCloudPublicConfig } from "../features/cloud/publicConfig";
import { tracingLayer } from "../features/observability/tracing";
import * as Persistence from "../persistence/layer";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relay.url ?? "http://relay.invalid";
}

const httpClientLayer = remoteHttpClientLayer(fetch);

// Force ArrayBuffer binary frames. The effect Socket layer async-decodes Blob
// frames via `event.data.arrayBuffer()`, which can reorder frames under load and
// permanently desync the msgpack codec. ArrayBuffer frames arrive synchronously
// in wire order, so no async decode is needed.
const webSocketConstructorLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  (url, protocols) => {
    const ws = new globalThis.WebSocket(url, protocols);
    ws.binaryType = "arraybuffer";
    return ws;
  },
);

type RuntimeLayerSource =
  | ReturnType<typeof managedRelayClientLayer>
  | typeof webSocketConstructorLayer
  | typeof cryptoLayer
  | typeof httpClientLayer
  | typeof Persistence.layer
  | typeof tracingLayer;

const runtimeLayer = Layer.merge(
  managedRelayClientLayer(configuredRelayUrl()),
  webSocketConstructorLayer,
).pipe(
  Layer.provideMerge(cryptoLayer),
  Layer.provideMerge(httpClientLayer),
  Layer.provideMerge(tracingLayer.pipe(Layer.provide(httpClientLayer))),
  Layer.provideMerge(Persistence.layer),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

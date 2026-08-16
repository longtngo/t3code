import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";

import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";
import * as PrimaryEnvironmentHttpClient from "../environments/primary/httpClient";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";

import { browserCryptoLayer } from "../cloud/dpop";
import { managedRelayClientLayer } from "../cloud/managedRelayLayer";
import { resolveCloudPublicConfig, resolveRelayTracingConfig } from "../cloud/publicConfig";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relayUrl ?? "http://relay.invalid";
}

const httpClientLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
const relayTracingLayer = makeRelayClientTracingLayer(resolveRelayTracingConfig(), {
  serviceName: "t3-web-relay-client",
  serviceVersion: import.meta.env.APP_VERSION,
  runtime: "browser",
  client: typeof window !== "undefined" && window.desktopBridge ? "desktop" : "web",
}).pipe(Layer.provide(httpClientLayer));

// Force ArrayBuffer binary frames. The effect Socket layer async-decodes Blob
// frames via `event.data.arrayBuffer()`, which can reorder frames under load and
// permanently desync the msgpack codec. ArrayBuffer frames arrive synchronously
// in wire order, so no async decode is needed.
const webSocketConstructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
  const ws = new globalThis.WebSocket(url, protocols);
  ws.binaryType = "arraybuffer";
  return ws;
});

type RuntimeLayerSource =
  | typeof httpClientLayer
  | typeof browserCryptoLayer
  | typeof webSocketConstructorLayer
  | typeof relayTracingLayer
  | ReturnType<typeof managedRelayClientLayer>;

export const remoteHttpRuntime = ManagedRuntime.make(httpClientLayer);

const primaryHttpRuntime = ManagedRuntime.make(
  PrimaryEnvironmentHttpClient.layer.pipe(Layer.provide(primaryEnvironmentHttpLayer)),
);

export type PrimaryHttpEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => Promise<A>;

const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (effect) =>
  primaryHttpRuntime.runPromise(effect);

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => primaryHttpRunner(effect);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

const runtimeLayer = Layer.mergeAll(
  httpClientLayer,
  browserCryptoLayer,
  webSocketConstructorLayer,
  relayTracingLayer,
  managedRelayClientLayer(configuredRelayUrl()).pipe(
    Layer.provide(Layer.mergeAll(httpClientLayer, browserCryptoLayer)),
  ),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

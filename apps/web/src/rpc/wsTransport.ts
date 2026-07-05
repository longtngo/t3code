import {
  WsTransport as BaseWsTransport,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolSocketUrlProvider,
  type WsTransportOptions,
  type WsWireFormat,
} from "@t3tools/client-runtime";
import { createWsRpcProtocolLayer as createSharedWsRpcProtocolLayer } from "@t3tools/client-runtime";

import { ClientTracingLive } from "../observability/clientTracing";
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
} from "./wsConnectionState";

function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
  wireFormat?: WsWireFormat,
) {
  return createSharedWsRpcProtocolLayer(url, handlers, {
    wireFormat: wireFormat ?? "json",
    telemetryLifecycle: {
      onAttempt: recordWsConnectionAttempt,
      onOpen: recordWsConnectionOpened,
      onError: (message) => {
        recordWsConnectionErrored(message);
      },
      onClose: (details, context) => {
        if (context.intentional) {
          return;
        }
        recordWsConnectionClosed(details);
      },
    },
  });
}

const webWsTransportOptions = {
  tracingLayer: ClientTracingLive,
  createProtocolLayer: createWsRpcProtocolLayer,
} satisfies WsTransportOptions;

export class WsTransport extends BaseWsTransport {
  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    super(url, lifecycleHandlers, webWsTransportOptions);
  }
}

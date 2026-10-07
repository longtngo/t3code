// @effect-diagnostics nodeBuiltinImport:off - hands Node's server factory to NodeHttpServer, as layerTest does.
import * as NodeHttp from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpServer } from "effect/http";

/**
 * `NodeHttpServer.layerTest` bound to 127.0.0.1 instead of every interface.
 *
 * The test client always dials 127.0.0.1. macOS still hands an all-interfaces
 * listener a port that another program holds on 127.0.0.1 alone, and the
 * kernel then routes the client to that more specific foreign listener, so a
 * stray browser or dev server answers the test. Binding to 127.0.0.1 makes
 * such a port EADDRINUSE, so the kernel never assigns it.
 *
 * Options are forwarded to `NodeHttpServer.layer`; `port` defaults to 0.
 */
export const layerTestLoopback = (options?: Omit<NodeHttpServer.Options, "host">) =>
  HttpServer.layerTestClient.pipe(
    Layer.provide(
      Layer.fresh(FetchHttpClient.layer).pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
      ),
    ),
    Layer.provideMerge(
      NodeHttpServer.layer(NodeHttp.createServer, { port: 0, ...options, host: "127.0.0.1" }),
    ),
  );

// @effect-diagnostics nodeBuiltinImport:off - the foreign listener is a raw Node server, outside Effect.
import * as NodeHttp from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpServer, HttpServerResponse } from "effect/http";

import { HostProcessPlatform } from "../hostProcess.ts";
import { layerTestLoopback } from "./loopbackHttpServer.ts";

const FOREIGN_BODY = "foreign listener";

const listenOn = (server: NodeHttp.Server, port: number, host: string) =>
  Effect.callback<boolean>((resume) => {
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen(port, host, () => resume(Effect.succeed(true)));
  });

const closeServer = (server: NodeHttp.Server) =>
  Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)));

// The control binds all interfaces on this port afterwards, so it must be free there too.
const freeOnAllInterfaces = (port: number) =>
  Effect.gen(function* () {
    const probe = NodeHttp.createServer();
    const free = yield* listenOn(probe, port, "::");
    if (free) yield* closeServer(probe);
    return free;
  });

// Stands in for a stray browser or dev server: a listener on 127.0.0.1 only,
// on the first free port of a range reserved for this test.
const foreignLoopbackListener = Effect.acquireRelease(
  Effect.gen(function* () {
    for (let port = 47100; port <= 47199; port += 1) {
      const server = NodeHttp.createServer((_request, response) => response.end(FOREIGN_BODY));
      if (!(yield* freeOnAllInterfaces(port))) continue;
      if (yield* listenOn(server, port, "127.0.0.1")) return { server, port };
    }
    return yield* Effect.die(new Error("no free port in 47100-47199"));
  }),
  ({ server }) => closeServer(server),
);

const getRootBody = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("/");
  return yield* response.text;
});

const serveOwnBody = HttpServer.serveEffect(Effect.succeed(HttpServerResponse.text("own server")));

describe("layerTestLoopback", () => {
  // The control documents the macOS behaviour the helper works around, hence darwin-only.
  it.effect.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
    "control: an all-interfaces server on a port held on 127.0.0.1 is answered by the foreign listener",
    () =>
      Effect.gen(function* () {
        const { port } = yield* foreignLoopbackListener;
        const allInterfaces = HttpServer.layerTestClient.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port })),
        );
        const body = yield* Effect.andThen(serveOwnBody, getRootBody).pipe(
          Effect.provide(allInterfaces),
        );
        assert.strictEqual(body, FOREIGN_BODY);
      }),
  );

  it.effect("refuses a port another listener holds on 127.0.0.1", () =>
    Effect.gen(function* () {
      const { port } = yield* foreignLoopbackListener;
      const exit = yield* Layer.build(layerTestLoopback({ port })).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause);
      assert.strictEqual((error as { cause?: { code?: string } }).cause?.code, "EADDRINUSE");
    }),
  );
});

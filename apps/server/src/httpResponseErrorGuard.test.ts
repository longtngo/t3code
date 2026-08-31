// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";

const servers: NodeHttp.Server[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function fetchStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => reject(new Error("request timed out")));
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("guardHttpResponseWriteErrors", () => {
  it("contains an upgrade socket write failure instead of crashing the process", async () => {
    const writeErrors: unknown[] = [];
    const failureObserved = Promise.withResolvers<void>();
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
      failureObserved.resolve();
    });

    server.on("upgrade", (_request, socket) => {
      // Simulate the client vanishing while the auth rejection response is
      // written to the upgrade socket: the write failure surfaces as an
      // "error" event on a socket Node's http server no longer listens to.
      socket.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });

    const port = await listen(server);

    const client = NodeNet.connect(port, "127.0.0.1", () => {
      client.write(
        [
          "GET /rpc HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    client.on("error", () => {});

    await failureObserved.promise;
    client.destroy();

    expect(writeErrors).toHaveLength(1);
    expect(writeErrors[0]).toBeInstanceOf(Error);
    expect((writeErrors[0] as NodeJS.ErrnoException).code).toBe("EPIPE");

    // The process survived the failed write and the server keeps serving.
    server.on("request", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await expect(fetchStatus(port, "/")).resolves.toBe(200);
  });

  it("arms every response with an error listener without disturbing normal traffic", async () => {
    const writeErrors: unknown[] = [];
    let responseErrorListeners = -1;
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
    });

    server.on("request", (_request, response) => {
      responseErrorListeners = response.listenerCount("error");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });

    const port = await listen(server);

    await expect(fetchStatus(port, "/")).resolves.toBe(200);
    expect(responseErrorListeners).toBeGreaterThan(0);
    expect(writeErrors).toEqual([]);
  });

  it("destroys the connection when a body ends short of its Content-Length", async () => {
    const guardErrors: unknown[] = [];
    const shortBodyObserved = Promise.withResolvers<void>();
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      guardErrors.push(error);
      shortBodyObserved.resolve();
    });

    // A file that shrinks mid-stream produces exactly this: headers already
    // declared N bytes, the body stops early, and Node considers the response
    // complete. Left alone the connection returns to the keep-alive pool, and the
    // next response is written inside what the client is still counting as this
    // body — measured as a real cross-response desync.
    server.on("request", (_request, response) => {
      response.writeHead(200, { "Content-Length": "100", "Content-Type": "text/plain" });
      response.end("short");
    });

    const port = await listen(server);
    // The client sees a truncated body and errors; that is the point, so the
    // rejection is expected rather than a failure.
    await new Promise<void>((resolve) => {
      const request = NodeHttp.get({ host: "127.0.0.1", port, path: "/f" }, (response) => {
        response.on("data", () => {});
        response.on("error", () => resolve());
        response.on("close", () => resolve());
      });
      request.on("error", () => resolve());
    });
    // Bounded: without the guard nothing ever resolves this, and an unbounded
    // await turns the failure into a suite-length timeout instead of an assertion.
    await Promise.race([
      shortBodyObserved.promise,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);

    expect(guardErrors).toHaveLength(1);
    expect(String(guardErrors[0])).toContain("95 bytes short");
  });

  it("leaves an honest response and a bodiless status alone", async () => {
    const guardErrors: unknown[] = [];
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      guardErrors.push(error);
    });

    server.on("request", (request, response) => {
      if (request.url === "/empty") {
        // 204 carries no body, so zero bytes against any declared length is
        // correct rather than truncated.
        response.writeHead(204, { "Content-Length": "42" });
        response.end();
        return;
      }
      if (request.url === "/chunked") {
        // No Content-Length: chunked framing already says where the body ends.
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("anything");
        return;
      }
      response.writeHead(200, { "Content-Length": "5", "Content-Type": "text/plain" });
      response.end("exact");
    });

    const port = await listen(server);
    for (const path of ["/exact", "/empty", "/chunked"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      await response.arrayBuffer();
    }

    expect(guardErrors).toEqual([]);
  });
});

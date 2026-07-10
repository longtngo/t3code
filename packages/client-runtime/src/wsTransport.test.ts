import { WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetWireFormatNegotiation, setAdvertisedWireFormat } from "./wsRpcProtocol.ts";
import { formatErrorMessage, WsTransport } from "./wsTransport.ts";

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
type WsListener = (event?: WsEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  error() {
    this.emit("error", { type: "error" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const transports: WsTransport[] = [];

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = performance.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (performance.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await Effect.runPromise(Effect.sleep(Duration.millis(10)));
    }
  }
}

function createTransport(...args: ConstructorParameters<typeof WsTransport>): WsTransport {
  const transport = new WsTransport(...args);
  transports.push(transport);
  return transport;
}

beforeEach(() => {
  vi.useRealTimers();
  sockets.length = 0;
  transports.length = 0;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        hostname: "localhost",
        port: "3020",
        protocol: "http:",
      },
      desktopBridge: undefined,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  // The MockWebSocket feeds JSON frames, so exercise the transport over JSON. The
  // production msgpack path is covered by the shared serialization unit tests, the
  // Node RPC round-trip test, and the browser codec test.
  setAdvertisedWireFormat("json");
});

afterEach(async () => {
  await Promise.allSettled(transports.map((transport) => transport.dispose()));
  transports.length = 0;
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  // Restore the module's real default (the client's top preference) so this suite
  // never leaves the global pinned to a lower format for a later suite in the worker.
  setAdvertisedWireFormat("msgpack-deflate-stream-v2");
  vi.restoreAllMocks();
});

describe("formatErrorMessage", () => {
  it("returns the message of a non-empty Error (so transport-connection detection keeps working)", () => {
    expect(formatErrorMessage(new Error("SocketCloseError: connection lost"))).toBe(
      "SocketCloseError: connection lost",
    );
  });

  it("falls back to String() for an Error with an empty message", () => {
    expect(formatErrorMessage(new Error(""))).toBe("Error");
  });

  it("surfaces a tagged error's _tag and message instead of [object Object]", () => {
    expect(formatErrorMessage({ _tag: "RpcError", message: "decode failed" })).toBe(
      "RpcError: decode failed",
    );
  });

  it("surfaces _tag or message alone", () => {
    expect(formatErrorMessage({ _tag: "ClosedError" })).toBe("ClosedError");
    expect(formatErrorMessage({ message: "boom" })).toBe("boom");
  });

  it("JSON-encodes a structured object that has no _tag/message", () => {
    expect(formatErrorMessage({ code: 42, reason: "nope" })).toBe('{"code":42,"reason":"nope"}');
  });

  it("renders an empty object as {} rather than [object Object]", () => {
    expect(formatErrorMessage({})).toBe("{}");
  });

  it("falls back to String() for unserializable objects (circular refs)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatErrorMessage(circular)).toBe("[object Object]");
  });

  it("handles primitive and nullish values", () => {
    expect(formatErrorMessage("plain string")).toBe("plain string");
    expect(formatErrorMessage(42)).toBe("42");
    expect(formatErrorMessage(null)).toBe("null");
    expect(formatErrorMessage(undefined)).toBe("undefined");
  });
});

describe("WsTransport", () => {
  it("normalizes root websocket urls to /ws and preserves query params", async () => {
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("advertises the compressed-msgpack wire format in the handshake url once the server confirms support", async () => {
    // Preferring msgpack no longer sends binary blindly: the client probes the
    // server's capability endpoint first. Mock a server that supports it.
    const capabilitiesFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ wireFormats: ["json", "msgpack-deflate"] }),
    }));
    globalThis.fetch = capabilitiesFetch as unknown as typeof globalThis.fetch;
    setAdvertisedWireFormat("msgpack-deflate");
    resetWireFormatNegotiation();
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(capabilitiesFetch).toHaveBeenCalledWith(
      "http://localhost:3020/ws/capabilities",
      expect.objectContaining({ method: "GET" }),
    );
    expect(getSocket().url).toBe(
      "ws://localhost:3020/ws?token=secret-token&fmt=msgpack-deflate",
    );
    await transport.dispose();
  });

  it("advertises the context-takeover stream format when the server supports it", async () => {
    // The client's top preference is the streaming (context-takeover) format; a
    // server that lists it gets `?fmt=msgpack-deflate-stream-v2`.
    const capabilitiesFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        wireFormats: ["json", "msgpack-deflate", "msgpack-deflate-stream-v2"],
      }),
    }));
    globalThis.fetch = capabilitiesFetch as unknown as typeof globalThis.fetch;
    setAdvertisedWireFormat("msgpack-deflate-stream-v2");
    resetWireFormatNegotiation();
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe(
      "ws://localhost:3020/ws?token=secret-token&fmt=msgpack-deflate-stream-v2",
    );
    await transport.dispose();
  });

  it("downgrades to per-frame msgpack when the server lacks the stream format", async () => {
    // A newer client prefers stream, but a server that only advertises per-frame
    // msgpack must be spoken to in per-frame msgpack — never `?fmt=stream` it can't decode.
    const capabilitiesFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ wireFormats: ["json", "msgpack-deflate"] }),
    }));
    globalThis.fetch = capabilitiesFetch as unknown as typeof globalThis.fetch;
    setAdvertisedWireFormat("msgpack-deflate-stream-v2");
    resetWireFormatNegotiation();
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe(
      "ws://localhost:3020/ws?token=secret-token&fmt=msgpack-deflate",
    );
    await transport.dispose();
  });

  it("falls back to JSON when the server has no capability endpoint (older server)", async () => {
    // An older server 404s the probe route; the client must NOT send binary frames.
    const capabilitiesFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));
    globalThis.fetch = capabilitiesFetch as unknown as typeof globalThis.fetch;
    setAdvertisedWireFormat("msgpack-deflate");
    resetWireFormatNegotiation();
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("falls back to JSON when the capability probe rejects (network error / CORS)", async () => {
    const capabilitiesFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = capabilitiesFetch as unknown as typeof globalThis.fetch;
    setAdvertisedWireFormat("msgpack-deflate");
    resetWireFormatNegotiation();
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("re-probes on a later connection after a transient probe failure (does not pin JSON)", async () => {
    setAdvertisedWireFormat("msgpack-deflate");
    resetWireFormatNegotiation();

    // First connection: the probe fails transiently → JSON, and the failure is
    // NOT cached, so a later connection to the same origin can still upgrade.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    const first = createTransport("ws://localhost:3020/?token=secret-token");
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    await first.dispose();

    // Network recovers: the second connection re-probes and upgrades to msgpack.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ wireFormats: ["json", "msgpack-deflate"] }),
    })) as unknown as typeof globalThis.fetch;
    const second = createTransport("ws://localhost:3020/?token=secret-token");
    await waitFor(() => {
      expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token&fmt=msgpack-deflate");
    });
    await second.dispose();
  });

  it("does not leak a live socket when disposed during the capability probe", async () => {
    setAdvertisedWireFormat("msgpack-deflate");
    resetWireFormatNegotiation();

    // A probe we resolve by hand, so we can dispose while it is still in flight.
    let releaseProbe: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    globalThis.fetch = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ wireFormats: ["json", "msgpack-deflate"] }),
      };
    }) as unknown as typeof globalThis.fetch;

    const transport = createTransport("ws://localhost:3020/?token=secret-token");
    // Dispose starts while the probe is unresolved; it awaits the in-flight init.
    const disposal = transport.dispose();
    releaseProbe();
    await disposal;

    // The session built after dispose (if any) must have been torn down — never a
    // lingering OPEN socket.
    for (const socket of sockets) {
      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    }
  });

  it("uses an explicit secure websocket base url", async () => {
    const transport = createTransport("wss://app.example.com");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://app.example.com/ws");
    await transport.dispose();
  });

  it("uses an explicit insecure websocket base url for remote backends", async () => {
    const transport = createTransport("ws://192.168.1.44:3773");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://192.168.1.44:3773/ws");
    await transport.dispose();
  });

  it("supports async websocket url providers", async () => {
    const transport = createTransport(async () => "wss://remote.example.com/?wsTicket=dynamic");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://remote.example.com/ws?wsTicket=dynamic");
    await transport.dispose();
  });

  it("invokes optional lifecycle handlers when the socket opens and closes", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      onOpen,
      onClose,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledOnce();
    });

    socket.close(1012, "service restart");

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith(
        {
          code: 1012,
          reason: "service restart",
        },
        {
          intentional: false,
        },
      );
    });

    await transport.dispose();
  });

  it("tracks heartbeat freshness from websocket pongs", async () => {
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const onHeartbeatPong = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onHeartbeatPong });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(transport.isHeartbeatFresh()).toBe(false);

    const socket = getSocket();
    socket.open();
    socket.serverMessage(JSON.stringify({ _tag: "Pong" }));

    await waitFor(() => {
      expect(onHeartbeatPong).toHaveBeenCalledOnce();
    });

    expect(transport.isHeartbeatFresh()).toBe(true);
    expect(transport.isHeartbeatFresh(500)).toBe(true);

    nowSpy.mockReturnValue(1_501);
    expect(transport.isHeartbeatFresh(500)).toBe(false);

    await transport.dispose();
  });

  it("clears heartbeat freshness when reconnecting", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const onHeartbeatPong = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onHeartbeatPong });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();
    firstSocket.serverMessage(JSON.stringify({ _tag: "Pong" }));

    await waitFor(() => {
      expect(onHeartbeatPong).toHaveBeenCalledOnce();
    });
    expect(transport.isHeartbeatFresh()).toBe(true);

    await transport.reconnect();

    expect(transport.isHeartbeatFresh()).toBe(false);

    await transport.dispose();
  });

  it("does not report an intentional dispose as a close", async () => {
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onClose });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();
    await transport.dispose();

    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores stale socket lifecycle events after reconnect starts a new session", async () => {
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onClose });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    firstSocket.close(1006, "stale close");

    expect(onClose).not.toHaveBeenCalled();

    await transport.dispose();
  });

  it("reconnects the websocket session without disposing the transport", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(secondSocket.sent[0] ?? "{}") as { id: string };
    secondSocket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });

  it("sends unary RPC requests and resolves successful exits", async () => {
    const transport = createTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      _tag: string;
      id: string;
      payload: unknown;
      tag: string;
    };
    expect(requestMessage).toMatchObject({
      _tag: "Request",
      tag: WS_METHODS.serverUpsertKeybinding,
      payload: {
        command: "terminal.toggle",
        key: "ctrl+k",
      },
    });

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });

  it("delivers stream chunks to subscribers", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string; tag: string };
    expect(requestMessage.tag).toBe(WS_METHODS.subscribeServerLifecycle);

    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    };

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [welcomeEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(welcomeEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes stream listeners after the stream exits", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: {
              environment: {
                environmentId: "environment-local",
                label: "Local environment",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              },
              cwd: "/tmp/one",
              projectName: "one",
            },
          },
        ],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.id !== firstRequest.id,
      );
    if (!secondRequest) {
      throw new Error("Expected a resubscribe request");
    }
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/two",
        projectName: "two",
      },
    };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes live stream listeners after an explicit transport reconnect", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };
    const firstEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/one",
        projectName: "one",
      },
    };

    firstSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [firstEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(firstEvent);
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const secondRequest = JSON.parse(secondSocket.sent[0] ?? "{}") as {
      id: string;
      tag: string;
    };
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/two",
        projectName: "two",
      },
    };

    secondSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("does not fire onResubscribe when the first stream attempt exits before any value", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });
    expect(onResubscribe).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    await transport.dispose();
  });

  it("does not retry stream subscriptions after application-level failures", async () => {
    const warnSpy = vi.fn();
    const transport = createTransport("ws://localhost:3020", undefined, { logWarning: warnSpy });
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("Git command failed in GitCore.statusDetails"));
        }),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBe(1);
    });
    await Effect.runPromise(Effect.sleep(Duration.millis(50)));

    expect(attempts).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription failed", {
      error: "Git command failed in GitCore.statusDetails",
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      "WebSocket RPC subscription disconnected",
      expect.anything(),
    );

    unsubscribe();
    await transport.dispose();
  });

  it("keeps retrying stream subscriptions after transport failures", async () => {
    const warnSpy = vi.fn();
    const transport = createTransport("ws://localhost:3020", undefined, { logWarning: warnSpy });
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("Socket is not connected"));
        }),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBeGreaterThanOrEqual(2);
    });

    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "Socket is not connected",
    });

    unsubscribe();
    await transport.dispose();
  });

  it("logs a transport disconnect once even when multiple subscriptions fail together", async () => {
    const warnSpy = vi.fn();
    const transport = createTransport("ws://localhost:3020", undefined, { logWarning: warnSpy });

    const unsubscribeA = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );
    const unsubscribeB = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: 1006",
    });

    unsubscribeA();
    unsubscribeB();
    await transport.dispose();
  });

  it("streams finite request events without re-subscribing", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.requestStream(
      (client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: "action-1",
          cwd: "/repo",
          action: "commit",
        }),
      listener,
    );

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    const progressEvent = {
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    } as const;

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [progressEvent],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await expect(requestPromise).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith(progressEvent);
    expect(
      socket.sent.filter((message) => {
        const parsed = JSON.parse(message) as { _tag?: string; tag?: string };
        return parsed._tag === "Request" && parsed.tag === WS_METHODS.gitRunStackedAction;
      }),
    ).toHaveLength(1);
    await transport.dispose();
  });

  it("closes the client scope on the transport runtime before disposing the runtime", async () => {
    const callOrder: string[] = [];
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const runtime = {
      runPromise: vi.fn(async () => {
        callOrder.push("close:start");
        await closePromise;
        callOrder.push("close:done");
        return undefined;
      }),
      dispose: vi.fn(async () => {
        callOrder.push("runtime:dispose");
      }),
    };
    const transport = {
      disposed: false,
      session: {
        clientScope: {} as never,
        runtime,
      },
      closeSession: (
        WsTransport.prototype as unknown as {
          closeSession: (session: {
            clientScope: unknown;
            runtime: { dispose: () => Promise<void>; runPromise: () => Promise<void> };
          }) => Promise<void>;
        }
      ).closeSession,
    } as unknown as WsTransport;

    void WsTransport.prototype.dispose.call(transport);

    expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect((transport as unknown as { disposed: boolean }).disposed).toBe(true);

    resolveClose();

    await waitFor(() => {
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    expect(callOrder).toEqual(["close:start", "close:done", "runtime:dispose"]);
  });
});

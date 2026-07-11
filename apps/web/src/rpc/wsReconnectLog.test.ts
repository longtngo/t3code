import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { logWsReconnectEvent, wsReconnectLoggingEnabled } from "./wsReconnectLog";

function setStoredFlag(value: string | null): void {
  const store = globalThis as {
    localStorage?: { getItem(key: string): string | null };
  };
  store.localStorage = {
    getItem: (key: string) => (key === "t3.wsReconnect" ? value : null),
  };
}

function clearStorage(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

afterEach(() => {
  clearStorage();
  vi.restoreAllMocks();
});

describe("wsReconnectLoggingEnabled", () => {
  it("is off by default when no flag is set", () => {
    setStoredFlag(null);
    expect(wsReconnectLoggingEnabled()).toBe(false);
  });

  it("is on when the flag is exactly '1'", () => {
    setStoredFlag("1");
    expect(wsReconnectLoggingEnabled()).toBe(true);
  });

  it("does not throw and is off when localStorage is absent (SSR)", () => {
    clearStorage();
    expect(() => wsReconnectLoggingEnabled()).not.toThrow();
    expect(wsReconnectLoggingEnabled()).toBe(false);
  });

  it("does not throw and is off when localStorage access throws (sandboxed)", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(() => wsReconnectLoggingEnabled()).not.toThrow();
    expect(wsReconnectLoggingEnabled()).toBe(false);
  });
});

describe("logWsReconnectEvent", () => {
  it("is a no-op when logging is disabled", () => {
    setStoredFlag(null);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logWsReconnectEvent("attempt", "primary");
    expect(info).not.toHaveBeenCalled();
  });

  it("emits one labeled line when logging is enabled", () => {
    setStoredFlag("1");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logWsReconnectEvent("close", "primary", { code: 1006 });
    expect(info).toHaveBeenCalledTimes(1);
    const [message, detail] = info.mock.calls[0] as [string, unknown];
    expect(message).toContain("[ws-reconnect] close");
    expect(message).toContain("label=primary");
    expect(detail).toEqual({ code: 1006 });
  });

  it("renders a missing label as '?'", () => {
    setStoredFlag("1");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logWsReconnectEvent("open", null);
    const [message] = info.mock.calls[0] as [string];
    expect(message).toContain("label=?");
  });
});

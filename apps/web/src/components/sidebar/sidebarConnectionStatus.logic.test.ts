import { describe, expect, it } from "vite-plus/test";
import {
  connectionDetailLine,
  connectionDotTone,
  connectionEndpointLabel,
  connectionHost,
} from "./sidebarConnectionStatus.logic";

describe("connectionDotTone", () => {
  it("is green and steady when connected", () => {
    expect(connectionDotTone("connected")).toMatchObject({ pulse: false, label: "Connected" });
  });
  it("pulses amber while reconnecting/connecting", () => {
    expect(connectionDotTone("reconnecting").pulse).toBe(true);
    expect(connectionDotTone("connecting").pulse).toBe(true);
  });
  it("is red when offline or errored", () => {
    expect(connectionDotTone("offline").label).toBe("Offline");
    expect(connectionDotTone("error").label).toBe("Disconnected");
  });
});

describe("connectionHost", () => {
  it("extracts host:port from a ws/wss url", () => {
    expect(connectionHost("wss://longngo-uni-m5.tailb9450f.ts.net/ws")).toBe(
      "longngo-uni-m5.tailb9450f.ts.net",
    );
    expect(connectionHost("ws://127.0.0.1:13773/ws")).toBe("127.0.0.1:13773");
  });
  it("returns null for null or unparseable input", () => {
    expect(connectionHost(null)).toBeNull();
    expect(connectionHost("not a url")).toBeNull();
  });
});

describe("connectionEndpointLabel", () => {
  it("prefers a trimmed explicit label", () => {
    expect(connectionEndpointLabel("  My Mac  ", "wss://host/ws")).toBe("My Mac");
  });
  it("falls back to the socket host when there is no usable label", () => {
    expect(connectionEndpointLabel(null, "wss://host:8443/ws")).toBe("host:8443");
    expect(connectionEndpointLabel("   ", "wss://host/ws")).toBe("host");
  });
  it("is null when neither label nor host is available", () => {
    expect(connectionEndpointLabel(null, null)).toBeNull();
  });
});

describe("connectionDetailLine", () => {
  const base = {
    endpoint: null,
    sinceLabel: null,
    retryCountdown: null,
    closeReason: null,
  } as const;

  it("shows the endpoint when connected", () => {
    expect(
      connectionDetailLine({ ...base, uiState: "connected", endpoint: "host.ts.net" }),
    ).toBe("host.ts.net");
  });
  it("falls back to the since-time when connected without an endpoint", () => {
    expect(connectionDetailLine({ ...base, uiState: "connected", sinceLabel: "1:35 PM" })).toBe(
      "Since 1:35 PM",
    );
  });
  it("is null when connected with neither endpoint nor time", () => {
    expect(connectionDetailLine({ ...base, uiState: "connected" })).toBeNull();
  });
  it("shows the retry countdown while reconnecting", () => {
    expect(connectionDetailLine({ ...base, uiState: "reconnecting", retryCountdown: "5s" })).toBe(
      "Retry in 5s",
    );
  });
  it("falls back to a generic message while reconnecting without a countdown", () => {
    expect(connectionDetailLine({ ...base, uiState: "reconnecting" })).toBe("Reconnecting…");
  });
  it("names the endpoint while connecting", () => {
    expect(connectionDetailLine({ ...base, uiState: "connecting", endpoint: "host" })).toBe(
      "Connecting to host…",
    );
    expect(connectionDetailLine({ ...base, uiState: "connecting" })).toBe("Connecting…");
  });
  it("prompts to check the network when offline", () => {
    expect(connectionDetailLine({ ...base, uiState: "offline" })).toBe("Check your network");
  });
  it("surfaces the close reason on error, else a default", () => {
    expect(
      connectionDetailLine({ ...base, uiState: "error", closeReason: "Server restarting" }),
    ).toBe("Server restarting");
    expect(connectionDetailLine({ ...base, uiState: "error", closeReason: "   " })).toBe(
      "Disconnected",
    );
    expect(connectionDetailLine({ ...base, uiState: "error" })).toBe("Disconnected");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { connectionDotTone } from "./sidebarConnectionStatus.logic";

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

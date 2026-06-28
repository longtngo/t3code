import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
} from "../rpc/wsConnectionState";
import { toastManager } from "./ui/toast";
import { WebSocketConnectionCoordinator } from "./WebSocketConnectionSurface";

const flushEffects = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("WebSocketConnectionCoordinator", () => {
  afterEach(() => {
    resetWsConnectionStateForTests();
    vi.restoreAllMocks();
  });

  // Guards the headline contract of this work: connection-state changes are
  // surfaced ONLY through the ambient indicator — never a toast. The toast
  // machinery was deleted; this fails if anyone re-introduces a toast.add /
  // toast.update on any connection transition (drop, error, offline, recovery).
  it("never surfaces a toast as the connection drops, errors, goes offline, and recovers", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    const updateToast = vi.spyOn(toastManager, "update");

    const screen = await render(<WebSocketConnectionCoordinator />);
    try {
      // Connect.
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionOpened();
      await flushEffects();

      // Live socket drops -> reconnecting.
      recordWsConnectionClosed({ code: 1013, reason: "try again later" });
      await flushEffects();

      // A reconnect attempt errors.
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionErrored("connection refused");
      await flushEffects();

      // Network goes offline.
      setBrowserOnlineStatus(false);
      recordWsConnectionClosed({ code: 1006, reason: "offline" });
      await flushEffects();

      // Network returns and the socket recovers.
      setBrowserOnlineStatus(true);
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionOpened();
      await flushEffects();

      expect(addToast).not.toHaveBeenCalled();
      expect(updateToast).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

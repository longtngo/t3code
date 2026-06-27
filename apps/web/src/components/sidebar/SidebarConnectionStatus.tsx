import { useEffect, useState } from "react";
import {
  getWsConnectionUiState,
  type WsConnectionStatus,
  type WsConnectionUiState,
  useWsConnectionStatus,
} from "../../rpc/wsConnectionState";
import { formatConnectionMoment, formatRetryCountdown } from "../WebSocketConnectionSurface";
import {
  connectionDetailLine,
  connectionDotTone,
  connectionEndpointLabel,
} from "./sidebarConnectionStatus.logic";

function buildTitle(
  status: WsConnectionStatus,
  uiState: WsConnectionUiState,
  label: string,
): string {
  if (uiState === "connected") {
    const endpoint = connectionEndpointLabel(status.connectionLabel, status.socketUrl);
    const since = formatConnectionMoment(status.connectedAt);
    return ["Connected", endpoint ? `to ${endpoint}` : null, since ? `since ${since}` : null]
      .filter(Boolean)
      .join(" ");
  }
  const dropped = formatConnectionMoment(status.disconnectedAt);
  const retry =
    status.nextRetryAt !== null
      ? ` · retry in ${formatRetryCountdown(status.nextRetryAt, Date.now())}`
      : "";
  return `${label}${dropped ? ` since ${dropped}` : ""}${retry}`;
}

/** Re-render once per second while the connection is unsettled, so the retry countdown ticks. */
function useNowTickWhile(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

export default function SidebarConnectionStatus() {
  const status = useWsConnectionStatus();
  const uiState = getWsConnectionUiState(status);
  const tone = connectionDotTone(uiState);
  const nowMs = useNowTickWhile(uiState !== "connected");
  const endpoint = connectionEndpointLabel(status.connectionLabel, status.socketUrl);
  const detail = connectionDetailLine({
    uiState,
    endpoint,
    sinceLabel: formatConnectionMoment(status.connectedAt),
    retryCountdown:
      status.nextRetryAt !== null ? formatRetryCountdown(status.nextRetryAt, nowMs) : null,
    closeReason: status.closeReason,
  });
  return (
    <div
      className="flex flex-col gap-0.5 px-2 py-1 text-xs"
      title={buildTitle(status, uiState, tone.label)}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <span
          aria-hidden
          className={`inline-block size-2 rounded-full ${tone.colorClass} ${tone.pulse ? "animate-pulse" : ""}`}
        />
        <span>{tone.label}</span>
      </div>
      {detail ? (
        <span className="truncate pl-4 text-[10px] text-muted-foreground/60" title={detail}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}

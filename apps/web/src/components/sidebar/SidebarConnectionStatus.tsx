import { getWsConnectionUiState, type WsConnectionUiState, useWsConnectionStatus } from "../../rpc/wsConnectionState";
import { formatConnectionMoment, formatRetryCountdown } from "../WebSocketConnectionSurface";
import { connectionDotTone } from "./sidebarConnectionStatus.logic";

function buildTitle(
  status: ReturnType<typeof useWsConnectionStatus>,
  uiState: WsConnectionUiState,
  label: string,
): string {
  if (uiState === "connected") {
    const since = formatConnectionMoment(status.connectedAt);
    return since ? `Connected since ${since}` : "Connected";
  }
  const dropped = formatConnectionMoment(status.disconnectedAt);
  const retry =
    status.nextRetryAt !== null ? ` · retry in ${formatRetryCountdown(status.nextRetryAt, Date.now())}` : "";
  return `${label}${dropped ? ` since ${dropped}` : ""}${retry}`;
}

export default function SidebarConnectionStatus({
  compact = false,
  className,
}: {
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const status = useWsConnectionStatus();
  const uiState = getWsConnectionUiState(status);
  const tone = connectionDotTone(uiState);
  const dot = (
    <span
      aria-hidden
      className={`inline-block size-2 rounded-full ${tone.colorClass} ${tone.pulse ? "animate-pulse" : ""}`}
    />
  );
  if (compact) {
    return (
      <span
        className={`flex items-center${className ? ` ${className}` : ""}`}
        title={buildTitle(status, uiState, tone.label)}
        aria-label={tone.label}
      >
        {dot}
      </span>
    );
  }
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1 text-muted-foreground text-xs${className ? ` ${className}` : ""}`}
      title={buildTitle(status, uiState, tone.label)}
    >
      {dot}
      <span>{tone.label}</span>
    </div>
  );
}

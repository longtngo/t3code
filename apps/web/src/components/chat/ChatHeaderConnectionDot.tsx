import { getWsConnectionUiState, useWsConnectionStatus } from "../../rpc/wsConnectionState";
import { connectionDotTone } from "../sidebar/sidebarConnectionStatus.logic";

/**
 * A tiny color-only connection dot for the mobile chat header. On mobile the
 * sidebar (and its footer connection indicator) is an overlay that is hidden
 * while closed, so this is the only always-visible passive connection signal —
 * green connected / amber-pulsing reconnecting / red offline. Its own atom
 * subscription keeps connection changes from re-rendering the whole ChatHeader.
 */
export default function ChatHeaderConnectionDot({ className }: { readonly className?: string }) {
  const tone = connectionDotTone(getWsConnectionUiState(useWsConnectionStatus()));
  return (
    <span
      role="img"
      aria-label={`Connection: ${tone.label}`}
      title={tone.label}
      className={`inline-flex shrink-0 items-center${className ? ` ${className}` : ""}`}
    >
      <span
        aria-hidden
        className={`inline-block size-2 rounded-full ${tone.colorClass} ${tone.pulse ? "animate-pulse" : ""}`}
      />
    </span>
  );
}

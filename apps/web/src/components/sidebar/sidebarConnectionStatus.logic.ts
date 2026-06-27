import type { WsConnectionUiState } from "../../rpc/wsConnectionState";

export interface ConnectionDotTone {
  readonly colorClass: string;
  readonly pulse: boolean;
  readonly label: string;
}

export function connectionDotTone(uiState: WsConnectionUiState): ConnectionDotTone {
  switch (uiState) {
    case "connected":
      return { colorClass: "bg-emerald-500", pulse: false, label: "Connected" };
    case "connecting":
      return { colorClass: "bg-amber-500", pulse: true, label: "Connecting" };
    case "reconnecting":
      return { colorClass: "bg-amber-500", pulse: true, label: "Reconnecting" };
    case "offline":
      return { colorClass: "bg-red-500", pulse: false, label: "Offline" };
    case "error":
      return { colorClass: "bg-red-500", pulse: false, label: "Disconnected" };
  }
}

// Pure mapping from an SDK notification priority to in-app toast styling.
// Extracted from the runtime service so the (silently-regressable) priority
// mapping is unit-testable without pulling in the whole runtime graph.

export interface NotificationToastStyle {
  type: "info" | "warning";
  priority: "low" | "high";
}

/**
 * Map a runtime.notification priority (low | medium | high | immediate) to a
 * toast type + priority. high/immediate escalate to a high-priority warning
 * toast; low/medium stay as a low-priority info toast. Unknown values fall back
 * to info/low.
 */
export function priorityToToast(priority: unknown): NotificationToastStyle {
  return priority === "high" || priority === "immediate"
    ? { type: "warning", priority: "high" }
    : { type: "info", priority: "low" };
}

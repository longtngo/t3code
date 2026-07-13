import type { WorkLogEntry } from "../../session-logic";

/**
 * The body of a work-log entry's detail modal: either a pretty-printed JSON document (when the
 * entry carries a structured payload, or its detail string parses as JSON) or plain text.
 */
export type WorkEntryDetailBody =
  | { readonly kind: "json"; readonly json: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "empty" };

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Decide how to render a work-log entry's detail. Prefer the raw structured payload (rendered as
 * formatted JSON); otherwise, if the flattened detail string is itself JSON, parse and format it;
 * otherwise show the detail text as-is. Returns `empty` when there is nothing to show.
 */
export function formatWorkEntryDetail(entry: WorkLogEntry): WorkEntryDetailBody {
  const payload = entry.detailPayload;
  if (payload != null && typeof payload === "object") {
    return { kind: "json", json: prettyJson(payload) };
  }

  const detail = entry.detail;
  if (typeof detail === "string") {
    const trimmed = detail.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed != null && typeof parsed === "object") {
          return { kind: "json", json: prettyJson(parsed) };
        }
      } catch {
        // Not valid JSON — fall through to plain text.
      }
    }
    if (trimmed.length > 0) return { kind: "text", text: detail };
  }

  return { kind: "empty" };
}

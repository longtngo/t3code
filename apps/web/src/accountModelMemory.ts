// Per-instance last-used model. The composer's selection only holds one active
// pair, so the account switcher restores each account's model from here.
import type { ProviderInstanceId } from "@t3tools/contracts";

const STORAGE_KEY = "t3code:account-model-memory:v1";

function readStore(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Best-effort: a full or unavailable quota just disables the memory.
  }
}

/** Record the model last used with a given provider instance. */
export function rememberAccountModel(instanceId: ProviderInstanceId, model: string): void {
  const trimmed = model.trim();
  if (trimmed.length === 0) return;
  const store = readStore();
  if (store[instanceId] === trimmed) return;
  store[instanceId] = trimmed;
  writeStore(store);
}

/** Recall the model last used with a given provider instance, if any. */
export function recallAccountModel(instanceId: ProviderInstanceId): string | undefined {
  return readStore()[instanceId];
}

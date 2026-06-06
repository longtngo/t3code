import type { ServerProvider } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Dismissal identity for a provider-status banner.
 *
 * Keyed on instance + status + message so a dismissal holds exactly until the
 * provider's reported state changes: a refresh that re-reports the same
 * warning stays hidden, while recovery followed by a new (or different)
 * degradation produces a new key and resurfaces the banner. `checkedAt` is
 * deliberately excluded — it churns on every periodic refresh.
 */
export function providerStatusBannerKey(
  status: Pick<ServerProvider, "instanceId" | "status" | "message">,
): string {
  return `${status.instanceId}|${status.status}|${status.message ?? ""}`;
}

interface DismissedProviderStatusBannersState {
  dismissedKeys: ReadonlySet<string>;
  dismiss: (key: string) => void;
}

/**
 * Module-level so dismissals survive banner/ChatView remounts (e.g. thread
 * switches). Intentionally NOT persisted: provider status re-checks every few
 * minutes, and a persisted dismissal could hide a genuine auth problem
 * indefinitely.
 */
export const useDismissedProviderStatusBanners = create<DismissedProviderStatusBannersState>(
  (set) => ({
    dismissedKeys: new Set<string>(),
    dismiss: (key) => set((state) => ({ dismissedKeys: new Set(state.dismissedKeys).add(key) })),
  }),
);

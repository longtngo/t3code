/**
 * In-memory view state for the task sidebar's background/agent sections:
 * which completed items the user manually removed, which sections are collapsed,
 * and which item is selected for the detail panel.
 *
 * Deliberately NOT persisted: auto-clear (6h) is durable on its own because it
 * is a pure function of an item's completedAt, so the only thing persistence
 * would add is keeping a manual removal across reloads — an acceptable v1 gap
 * that avoids a second persisted store. Selection is session/UI state.
 *
 * @module sidebarViewStore
 */
import { create } from "zustand";

export type SidebarSectionKey = "tasks" | "background" | "agents";

export interface SelectedSidebarDetail {
  readonly kind: "agent" | "background";
  readonly id: string;
}

interface SidebarViewStore {
  readonly dismissedIds: Readonly<Record<string, true>>;
  readonly collapsedSections: Readonly<Record<SidebarSectionKey, boolean>>;
  readonly selectedDetail: SelectedSidebarDetail | null;
  readonly dismissItem: (id: string) => void;
  /** Batch-dismiss sidebar rows (background/agent ids or plan-step keys). */
  readonly dismissItems: (ids: ReadonlyArray<string>) => void;
  readonly toggleSection: (key: SidebarSectionKey) => void;
  readonly selectDetail: (selection: SelectedSidebarDetail) => void;
  readonly clearDetail: () => void;
}

export const useSidebarViewStore = create<SidebarViewStore>((set) => ({
  dismissedIds: {},
  collapsedSections: { tasks: false, background: false, agents: false },
  selectedDetail: null,
  dismissItem: (id) =>
    set((state) => {
      const next = { ...state.dismissedIds, [id]: true as const };
      // Removing the visible item also closes its detail panel if it was open.
      const selectedDetail = state.selectedDetail?.id === id ? null : state.selectedDetail;
      return { dismissedIds: next, selectedDetail };
    }),
  dismissItems: (ids) =>
    set((state) => {
      if (ids.length === 0) return state;
      const next = { ...state.dismissedIds };
      for (const id of ids) next[id] = true;
      const dismissed = new Set(ids);
      const selectedDetail =
        state.selectedDetail && dismissed.has(state.selectedDetail.id)
          ? null
          : state.selectedDetail;
      return { dismissedIds: next, selectedDetail };
    }),
  toggleSection: (key) =>
    set((state) => ({
      collapsedSections: { ...state.collapsedSections, [key]: !state.collapsedSections[key] },
    })),
  selectDetail: (selection) => set({ selectedDetail: selection }),
  clearDetail: () => set({ selectedDetail: null }),
}));

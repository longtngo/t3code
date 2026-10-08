import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SidebarSectionDefinition } from "@t3tools/contracts";
import * as Hex from "effect/encoding/Hex";

export interface SidebarSectionView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Sections exist only on a primary that stores them; anything else hides the section UI. */
export function resolveSidebarSections(
  config: {
    readonly environment: { readonly capabilities: { readonly sidebarSections?: boolean } };
    readonly settings: {
      readonly sidebarSections: Readonly<Record<string, SidebarSectionDefinition>>;
    };
  } | null,
): readonly SidebarSectionView[] | null {
  if (config === null || config.environment.capabilities.sidebarSections !== true) return null;
  return Object.entries(config.settings.sidebarSections)
    .map(([id, entry]) => ({ id, name: entry.name, createdAt: entry.createdAt }))
    .toSorted(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id),
    );
}

/** A reply without the written entries is a failure (an older or refusing server). */
export function sidebarSectionPatchLanded(
  stored: Readonly<Record<string, SidebarSectionDefinition>> | undefined,
  patch: Readonly<Record<string, SidebarSectionDefinition | null>>,
): boolean {
  if (stored === undefined) return false;
  return Object.entries(patch).every(([id, entry]) =>
    entry === null
      ? !Object.hasOwn(stored, id)
      : Object.hasOwn(stored, id) && stored[id]?.name === entry.name,
  );
}

/** A rename written against the sections as they are now, not as they were when the dialog
    opened: a section deleted meanwhile (here or on a peer) must not come back, and an unchanged
    submit (`name === openedName`) must not revert a peer's rename. */
export function planSidebarSectionRename(
  live: readonly SidebarSectionView[] | null,
  id: string,
  openedName: string,
  name: string,
): Record<string, SidebarSectionDefinition> | null {
  const current = live?.find((section) => section.id === id);
  if (current === undefined || name === openedName || current.name === name) return null;
  return { [id]: { name, createdAt: current.createdAt } };
}

/** A move target picked from a menu opened before a peer deleted it. Active is never gone. */
export function sidebarSectionGone(
  live: readonly SidebarSectionView[] | null,
  sectionId: string | null,
): boolean {
  return sectionId !== null && !live?.some((section) => section.id === sectionId);
}

/** "Move to section" / "Move to Active": set membership first, then clear what outranks it. */
export function planSidebarSectionMove(
  thread: ThreadSnoozeShell &
    Pick<EnvironmentThreadShell, "sidebarSectionId" | "pinnedAt" | "settledOverride">,
  sectionId: string | null,
  now: string,
): {
  readonly sectionId: string | null;
  readonly unpin: boolean;
  readonly unsettle: boolean;
  readonly unsnooze: boolean;
} | null {
  const plan = {
    sectionId,
    unpin: thread.pinnedAt != null,
    unsettle: thread.settledOverride === "settled",
    unsnooze: effectiveSnoozed(thread, { now }),
  };
  const unchanged =
    thread.sidebarSectionId === sectionId && !plan.unpin && !plan.unsettle && !plan.unsnooze;
  return unchanged ? null : plan;
}

type SidebarSectionMoveStep = "section" | "unpin" | "unsettle" | "unsnooze";

/** Runs a planned move in order and stops at the first failure, which it returns with its step. */
export async function runSidebarSectionMove(
  plan: NonNullable<ReturnType<typeof planSidebarSectionMove>>,
  steps: Readonly<
    Record<SidebarSectionMoveStep, () => Promise<AtomCommandResult<unknown, unknown>>>
  >,
): Promise<{
  readonly step: SidebarSectionMoveStep;
  readonly result: Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>;
} | null> {
  const order: ReadonlyArray<SidebarSectionMoveStep> = [
    "section",
    ...(plan.unpin ? (["unpin"] as const) : []),
    ...(plan.unsettle ? (["unsettle"] as const) : []),
    ...(plan.unsnooze ? (["unsnooze"] as const) : []),
  ];
  for (const step of order) {
    const result = await steps[step]();
    if (result._tag === "Failure") return { step, result };
  }
  return null;
}

/** After the membership write lands, a later failure leaves the thread moved: say which part
    didn't. `sectionName` is null for Move to Active. */
export function sidebarSectionMoveFailureTitle(
  step: SidebarSectionMoveStep,
  sectionName: string | null,
): string {
  const targetName = sectionName ?? "Active";
  switch (step) {
    case "section":
      return sectionName === null ? "Failed to move thread to Active" : "Failed to move thread";
    case "unpin":
      return `Moved to ${targetName}, but couldn't unpin`;
    case "unsettle":
      return `Moved to ${targetName}, but couldn't un-settle`;
    case "unsnooze":
      return `Moved to ${targetName}, but couldn't wake it`;
  }
}

export function sidebarSectionMoveTargets(
  sections: readonly SidebarSectionView[],
  currentSectionId: string | null,
): { readonly sections: readonly SidebarSectionView[]; readonly canMoveToActive: boolean } {
  return {
    sections: sections.filter((section) => section.id !== currentSectionId),
    canMoveToActive: sections.some((section) => section.id === currentSectionId),
  };
}

/** The sections a thread's "Move to …" entries offer, or null when it cannot move: the primary
    stores definitions, the thread's own server stores membership, and an archived thread has no
    sidebar place. Pass `canOperate` only where operate actions are hidden rather than disabled. */
export function sidebarSectionMoveState(input: {
  readonly sections: readonly SidebarSectionView[] | null;
  readonly thread: {
    readonly archivedAt?: string | null | undefined;
    readonly sidebarSectionId: string | null;
  };
  readonly supportsSections: boolean;
  readonly canOperate?: boolean;
}): {
  readonly sections: readonly SidebarSectionView[];
  readonly currentSectionId: string | null;
} | null {
  if (
    input.sections === null ||
    !input.supportsSections ||
    input.thread.archivedAt != null ||
    input.canOperate === false
  ) {
    return null;
  }
  return { sections: input.sections, currentSectionId: input.thread.sidebarSectionId };
}

export function sidebarSectionDeleteMessage(name: string, count: number): string {
  const detail =
    count === 0
      ? "It has no threads."
      : count === 1
        ? "Its 1 thread returns to Active."
        : `Its ${count} threads return to Active.`;
  return `Delete section "${name}"?\n${detail}`;
}

/** Colon-free, so its marker id never parses as a scoped thread key. `getRandomValues`, unlike
    `crypto.randomUUID`, also works on a plain-HTTP LAN origin. */
export function newSidebarSectionId(): string {
  return Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

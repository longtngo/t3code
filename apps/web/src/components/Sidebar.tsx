import { type EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "./chat/threadContextDrag";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  DndContext,
  DragOverlay,
  getClientRect,
  useDndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { canSnooze, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import { EllipsisIcon, FolderIcon, ListFilterIcon, PlusIcon, SettingsIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKey,
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { useUiStateStore } from "../uiStateStore";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  readThreadShell,
  useAllEnvironmentProjectSnapshotsReady,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentProjects } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";

import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { cn } from "~/lib/utils";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  resolveSidebarSectionMoveAction,
  threadActionRequiresOperate,
} from "./threadActionMenu.logic";
import {
  applySidebarThreadDrop,
  sidebarListedThreads,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  isSidebarNestedLinkClick,
  isSidebarThreadWorking,
  isTrailingDoubleClick,
  holdSidebarDrop,
  planSidebarThreadDrop,
  projectSidebarHeldDrop,
  sidebarHeldRows,
  sidebarShownQueueEntries,
  runSidebarDropCommands,
  sidebarDropDestinationKeys,
  sidebarOptimisticDrop,
  sidebarDropUnqueue,
  sidebarDropPlanInput,
  type SidebarDropBoard,
  type SidebarDropCommands,
  type SidebarOptimisticDrop,
  reduceSidebarProjectScopeMenuState,
  shouldReleaseOptimisticDrop,
  useSidebarDropHold,
  sidebarRestingSection,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarDropVerb,
  isSidebarDragCandidate,
  routeSidebarDragEnd,
  runSidebarSnoozeDrop,
  runSidebarEnqueueDrop,
  toggleSidebarDraftQueue,
  startSidebarPlaceDrop,
  nextSidebarDragOver,
  sidebarReleaseSnoozeState,
  sidebarDragListItems,
  sidebarDragLostItsRow,
  sidebarDragQueueEntryCount,
  sidebarPickupRefused,
  sidebarQueueBlockEntries,
  sidebarQueuePlacement,
  sidebarSnoozeDropAllowed,
  sidebarSnoozeZoneIds,
  type SidebarDragOrigin,
  type SidebarDragOverState,
  sidebarSectionCounts,
  buildSidebarListItems,
  customSectionHeaderId,
  countSidebarThreads,
  customSidebarSection,
  customSidebarSectionId,
  isCustomSidebarSection,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useThreadJumpHintVisibility,
  type SidebarSection,
  resolveSidebarRowThreadId,
  animateSidebarLayoutChanges,
} from "./Sidebar.logic";
import {
  addToQueueOrSayWhy,
  readThreadQueueMenuState,
  runThreadQueueMenuAction,
} from "../threadQueueAdd";
import { useSidebarSectionCommands, useSidebarSections } from "../sidebarCustomSections";
import { sidebarSectionMoveState, type SidebarSectionView } from "../sidebarCustomSections.logic";
import {
  QUEUE_DROP_ID,
  ForeignQueueRow,
  QUEUE_EXPANDED_KEY,
  SidebarQueueBlock,
  queuedOnAnotherDevice,
  type QueueRowSortableBag,
} from "./SidebarQueueBlock";
import { threadQueueEntryKey, type ThreadQueueEntry } from "../threadQueueRules";
import { queueDeviceId, useThreadQueueStore } from "../threadQueueStore";

import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  pointerOverVisibleRect,
  restrictBelowSidebarLabel,
  sidebarDragLabelsShift,
  sidebarSnoozeHintState,
  sidebarQueueBoundary,
  sidebarSortableIds,
  sidebarStrategyDragInput,
  SHOW_MORE_ID,
  SNOOZED_PLACEHOLDER_ID,
  type SidebarSnoozeHint,
} from "./Sidebar.drag";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";
import { createSidebarListMotion } from "./Sidebar.motion";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ProjectFavicon } from "./ProjectFavicon";
import { deriveProviderEntriesByEnvironment } from "../providerInstances";
import { useStableCallback } from "../hooks/useStableCallback";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "./ui/combobox";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { TooltipProvider } from "./ui/tooltip";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type DraftSessionState,
} from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  SIDEBAR_SORTABLE_DRAG_DISABLED,
  SidebarSearchResultRow,
  SidebarThreadRow,
  SortableThreadRow,
  type SidebarProviderEntry,
  type SidebarSweepAction,
  type SidebarThreadRowProps,
  type SortableThreadRowBag,
} from "./sidebar/SidebarThreadRow";
import { SidebarDraftBlock, SidebarDraftRow } from "./sidebar/SidebarDraftBlock";
import {
  SidebarDragBoundary,
  SidebarSectionHeader,
  SidebarSectionPlaceholder,
  SortableSidebarMarker,
} from "./sidebar/SidebarListMarkers";
import { CSS } from "@dnd-kit/utilities";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

function sameSidebarProviderEntries(
  left: ReadonlyMap<string, SidebarProviderEntry>,
  right: ReadonlyMap<string, SidebarProviderEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [instanceId, entry] of right) {
    const other = left.get(instanceId);
    if (
      other === undefined ||
      other.driverKind !== entry.driverKind ||
      other.enabled !== entry.enabled ||
      other.displayName !== entry.displayName ||
      other.accentColor !== entry.accentColor ||
      other.acpRegistryAgentId !== entry.acpRegistryAgentId ||
      other.acpRegistryIconUrl !== entry.acpRegistryIconUrl ||
      other.models !== entry.models
    ) {
      return false;
    }
  }
  return true;
}

// Threads on non-primary environments (T3 Connect, hosted) resolve their
// provider entry from their own environment's config: default instance ids
// are driver slugs, so a flat map would collide across environments.
const sidebarProviderEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const derived = deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  const previous = Option.getOrNull(
    get.self<ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>>(),
  );
  const next = new Map<string, ReadonlyMap<string, SidebarProviderEntry>>();
  let changed = previous === null || previous.size !== derived.size;
  for (const [environmentId, entries] of derived) {
    const prior = previous?.get(environmentId);
    if (prior !== undefined && sameSidebarProviderEntries(prior, entries)) {
      next.set(environmentId, prior);
    } else {
      next.set(environmentId, entries);
      changed = true;
    }
  }
  return !changed && previous !== null ? previous : next;
}).pipe(Atom.withLabel("sidebar-provider-entries"));

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();
// Collapsed shelves share one empty list so a route change alone does not
// give the sidebar list a new identity.
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
const SETTLED_SHELF_EXPANDED_KEY = "t3code:sidebar:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "t3code:sidebar:snoozed-expanded";
const WORKING_SHELF_EXPANDED_KEY = "t3code:sidebar:working-expanded";
// Per device, one key for every custom section: the ids the user collapsed.
const CUSTOM_SECTIONS_COLLAPSED_KEY = "t3code:sidebar:custom-sections-collapsed";
// Module-level so the useLocalStorage default keeps one identity across renders.
const NO_COLLAPSED_SECTION_IDS: readonly string[] = [];
// Stable while there are no sections, so navigation does not rebuild the sortable list.
const NO_CUSTOM_BLOCKS: readonly never[] = [];
const CollapsedCustomSectionIds = Schema.Array(Schema.String);

const inboxReturns = createInboxReturnTracker();

interface SidebarThreadPartitionInput {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly workingShelfEnabled: boolean;
  // A queued thread renders in the Queue instead of its section.
  readonly queuedKeys: ReadonlySet<string>;
  readonly customSectionIds: ReadonlySet<string>;
  // Snooze wakes and the queued-turn grace depend on the clock, so the minute
  // tick and the precise snooze-wake tick are inputs: a new key repartitions.
  readonly clockKey: string;
}

function threadShellKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

const NO_DRAGGED_ORDER: readonly string[] = [];
const NO_DRAGGED_ORDERS: {
  readonly settledOrder: readonly string[];
  readonly activeOrder: readonly string[] | undefined;
} = { settledOrder: NO_DRAGGED_ORDER, activeOrder: undefined };

// Where the dragged row would sort if dropped on the settled or the
// time-ordered active shelf; the strategy previews those slots.
function resolveDraggedOrders(input: {
  readonly drag: { readonly activeKey: string; readonly occurredAt: string };
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly workingShelfEnabled: boolean;
}): typeof NO_DRAGGED_ORDERS {
  const { drag, threadByKey, settledThreads, activeThreads, workingShelfEnabled } = input;
  const thread = threadByKey.get(drag.activeKey);
  if (thread === undefined) return NO_DRAGGED_ORDERS;
  const others = (list: readonly EnvironmentThreadShell[]) =>
    list.filter((candidate) => threadShellKey(candidate) !== drag.activeKey);
  return {
    settledOrder: sortSettledThreads([
      ...others(settledThreads),
      applySidebarThreadDrop(thread, "settled", drag.occurredAt),
    ]).map(threadShellKey),
    activeOrder: workingShelfEnabled
      ? sortInboxThreadsByReturn(
          [...others(activeThreads), applySidebarThreadDrop(thread, "active", drag.occurredAt)],
          inboxReturns.returnedAt,
        ).map(threadShellKey)
      : undefined,
  };
}

function routeThreadOnly(
  threads: readonly EnvironmentThreadShell[],
  routeThreadKey: string | null,
): readonly EnvironmentThreadShell[] {
  if (routeThreadKey === null) return EMPTY_THREADS;
  const routeThread = threads.find((thread) => threadShellKey(thread) === routeThreadKey);
  return routeThread === undefined ? EMPTY_THREADS : [routeThread];
}

// Everything Sidebar derives from thread shells. Computed inside one hook so
// each value reaches the component frozen and cached on its real inputs: in
// the component body, later hook calls made the compiler treat these maps as
// possibly mutated and recompute them, and every dnd-kit input with them.
function useSidebarThreads(input: {
  readonly projectScopeKey: string | null;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly queueEntries: readonly ThreadQueueEntry[];
  readonly sidebarSections: readonly SidebarSectionView[] | null;
  readonly queueExpanded: boolean;
}) {
  const {
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    routeThreadRef,
    queueEntries,
    sidebarSections,
    queueExpanded,
  } = input;
  // A held join renders in its section, not in the Queue.
  const shownQueueEntries = sidebarShownQueueEntries(queueEntries, optimisticDrop);
  const shownQueuedKeys = new Set(shownQueueEntries.map(threadQueueEntryKey));
  const customSectionIds = new Set((sidebarSections ?? []).map((section) => section.id));
  const threads = useThreadShells();
  const routeRowThreadKey =
    routeThreadRef === null
      ? null
      : scopedThreadKey(
          scopeThreadRef(
            routeThreadRef.environmentId,
            resolveSidebarRowThreadId(
              routeThreadRef.threadId,
              routeThreadRef.environmentId,
              threads,
            ),
          ),
        );
  const workingShelfEnabled = useClientSettings((s) => s.sidebarWorkingShelfEnabled);
  const nowMinute = useNowMinute();
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const [nextSnoozeWakeAt, setNextSnoozeWakeAt] = useState<string | null>(null);
  useEffect(
    () => scheduleSnoozeWake(nextSnoozeWakeAt, () => bumpSnoozeWakeTick((tick) => tick + 1)),
    [nextSnoozeWakeAt],
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [collapsedCustomSectionIds, setCollapsedCustomSectionIds] = useLocalStorage(
    CUSTOM_SECTIONS_COLLAPSED_KEY,
    NO_COLLAPSED_SECTION_IDS,
    CollapsedCustomSectionIds,
  );
  // The settled tail restarts whenever the project scope changes.
  const [settledTail, setSettledTail] = useState({
    scopeKey: projectScopeKey,
    count: SETTLED_TAIL_INITIAL_COUNT,
  });
  if (settledTail.scopeKey !== projectScopeKey) {
    setSettledTail({ scopeKey: projectScopeKey, count: SETTLED_TAIL_INITIAL_COUNT });
  }
  const settledVisibleCount =
    settledTail.scopeKey === projectScopeKey ? settledTail.count : SETTLED_TAIL_INITIAL_COUNT;

  const partition = partitionSidebarThreads({
    threads,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    queuedKeys: shownQueuedKeys,
    customSectionIds,
    clockKey: `${nowMinute}:${snoozeWakeTick}`,
  });
  const partitionNextWakeAt = partition.snoozedThreads[0]?.snoozedUntil ?? null;
  if (partitionNextWakeAt !== nextSnoozeWakeAt) setNextSnoozeWakeAt(partitionNextWakeAt);

  const {
    pinnedThreads,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    customThreads,
    snoozeNow,
  } = partition;
  const queuedThreads = (() => {
    const byKey = new Map(
      threads
        .filter((thread) => thread.archivedAt === null)
        .map((thread) => [threadShellKey(thread), thread] as const),
    );
    return shownQueueEntries.flatMap((entry) => {
      const thread = byKey.get(threadQueueEntryKey(entry));
      return thread === undefined ? [] : [thread];
    });
  })();
  const sectionCounts = sidebarSectionCounts(
    {
      working: workingThreads,
      snoozed: snoozedThreads,
      settled: settledThreads,
      custom: customThreads,
      queued: queuedThreads,
    },
    threadLastVisitedAtById,
    snoozeNow,
  );
  const visibleSettledThreads = (() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    if (routeRowThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find((thread) => threadShellKey(thread) === routeRowThreadKey);
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  })();
  const renderedSettledThreads = settledShelfExpanded
    ? visibleSettledThreads
    : routeThreadOnly(visibleSettledThreads, routeRowThreadKey);
  const visibleSnoozedThreads = snoozedShelfExpanded
    ? snoozedThreads
    : routeThreadOnly(snoozedThreads, routeRowThreadKey);
  // Collapsed, only the open queued thread keeps its row, as on the snoozed shelf.
  const visibleQueuedThreads = queueExpanded
    ? queuedThreads
    : queuedThreads.filter((thread) => threadShellKey(thread) === routeRowThreadKey);
  const visibleWorkingThreads = workingShelfExpanded
    ? workingThreads
    : routeThreadOnly(workingThreads, routeRowThreadKey);
  // Collapsed, a custom section keeps only the open thread's row, as the shelves do.
  const visibleCustomThreads =
    sidebarSections === null || sidebarSections.length === 0
      ? NO_CUSTOM_BLOCKS
      : sidebarSections.map((section) => {
          const rows = customThreads.get(section.id) ?? EMPTY_THREADS;
          return {
            section,
            visible: collapsedCustomSectionIds.includes(section.id)
              ? rows.filter((thread) => threadShellKey(thread) === routeRowThreadKey)
              : rows,
          };
        });
  const orderedThreads = [
    ...pinnedThreads,
    ...activeThreads,
    ...visibleQueuedThreads,
    ...visibleCustomThreads.flatMap((block) => block.visible),
    ...visibleWorkingThreads,
    ...visibleSnoozedThreads,
    ...renderedSettledThreads,
  ];
  const sectionByThreadKey = new Map<string, SidebarSection>();
  for (const [list, section] of [
    [pinnedThreads, "pinned"],
    [activeThreads, "active"],
    [workingThreads, "working"],
    [snoozedThreads, "snoozed"],
    [settledThreads, "settled"],
  ] as const) {
    for (const thread of list) sectionByThreadKey.set(threadShellKey(thread), section);
  }
  for (const [id, list] of customThreads) {
    for (const thread of list) {
      sectionByThreadKey.set(threadShellKey(thread), customSidebarSection(id));
    }
  }
  return {
    routeRowThreadKey,
    ...partition,
    threads,
    workingShelfEnabled,
    shownQueueEntries,
    customSectionIds,
    queuedThreads,
    sectionCounts,
    searchableThreads: [
      ...pinnedThreads,
      ...activeThreads,
      ...[...customThreads.values()].flat(),
      ...queuedThreads,
      ...workingThreads,
      ...snoozedThreads,
      ...settledThreads,
    ],
    settledVisibleCount,
    hiddenSettledCount: settledThreads.length - visibleSettledThreads.length,
    showMoreSettled: () =>
      setSettledTail((current) => ({
        scopeKey: current.scopeKey,
        count: current.count + SETTLED_TAIL_PAGE_COUNT,
      })),
    settledShelfExpanded,
    toggleSettledShelf: () => setSettledShelfExpanded((value) => !value),
    snoozedShelfExpanded,
    toggleSnoozedShelf: () => setSnoozedShelfExpanded((value) => !value),
    workingShelfExpanded,
    toggleWorkingShelf: () => setWorkingShelfExpanded((value) => !value),
    collapsedCustomSectionIds,
    toggleCustomSection: (id: string) =>
      setCollapsedCustomSectionIds((ids) =>
        // Collapsing also prunes ids of deleted sections; expanding leaves them (they show nothing).
        ids.includes(id)
          ? ids.filter((candidate) => candidate !== id)
          : [...ids.filter((candidate) => customSectionIds.has(candidate)), id],
      ),
    renderedSettledThreads,
    visibleSnoozedThreads,
    visibleQueuedThreads,
    visibleWorkingThreads,
    visibleCustomThreads,
    orderedThreadKeys: orderedThreads.map(threadShellKey),
    threadByKey: new Map(orderedThreads.map((thread) => [threadShellKey(thread), thread] as const)),
    settledThreadKeys: new Set(settledThreads.map(threadShellKey)),
    snoozedThreadKeys: new Set(snoozedThreads.map(threadShellKey)),
    sectionByThreadKey,
    pinnedKeys: pinnedThreads.map(threadShellKey),
    activeKeys: activeThreads.map(threadShellKey),
    customOrderKeys: new Map(
      [...customThreads].map(([id, list]) => [id, list.map(threadShellKey)] as const),
    ),
    pinnedKeysById: new Map(
      threads.map((thread) => [threadShellKey(thread), thread.pinOrderKey ?? null] as const),
    ),
    activeKeysById: new Map(
      threads.map((thread) => [threadShellKey(thread), thread.activeOrderKey ?? null] as const),
    ),
  };
}

function partitionSidebarThreads(input: SidebarThreadPartitionInput) {
  const {
    threads,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    queuedKeys,
    customSectionIds,
  } = input;
  const preciseNow = new Date().toISOString();
  // Subagent child threads live in the parent's Agents surface, not the
  // sidebar roster (v2 models them as real threads with lineage). A queued
  // thread renders in the Queue instead of its section.
  const {
    visible,
    pinned: draggable,
    active: activeReorderable,
  } = sidebarListedThreads({
    threads,
    scopedProjectKeys,
    queuedKeys,
    capabilitiesOf: (environmentId) => serverConfigs.get(environmentId)?.environment.capabilities,
  });
  inboxReturns.observe(workingShelfEnabled ? threads : null);
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const inbox = (thread: EnvironmentThreadShell) =>
    workingShelfEnabled && isSidebarThreadWorking(thread) ? working : active;
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const custom = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of visible) {
    const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
    const threadKey = threadShellKey(thread);
    // A held drop renders where it is going, as what it will be.
    const held =
      optimisticDrop?.key === threadKey ? projectSidebarHeldDrop(thread, optimisticDrop) : null;
    const row = held?.thread ?? thread;
    const section =
      held?.section ?? sidebarRestingSection(thread, capabilities, preciseNow, customSectionIds);
    if (isCustomSidebarSection(section)) {
      const id = customSidebarSectionId(section);
      const list = custom.get(id);
      if (list) list.push(row);
      else custom.set(id, [row]);
    } else {
      (section === "snoozed"
        ? snoozed
        : section === "settled"
          ? settled
          : section === "pinned"
            ? pinned
            : inbox(row)
      ).push(row);
    }
  }
  // Server capability only gates DRAGGING — it must not influence the
  // sort, or mixed-version fleets would render different pinned orders on
  // web and mobile from the same data.
  const sortedPinned = sortPinnedThreadsForSidebar(pinned);
  const sortedActive = workingShelfEnabled
    ? sortInboxThreadsByReturn(active, inboxReturns.returnedAt)
    : sortThreadsForSidebar(active);
  return {
    pinnedThreads: sidebarHeldRows(sortedPinned, "pinned", optimisticDrop, threadShellKey),
    draggableThreadKeys: draggable,
    activeReorderableThreadKeys: activeReorderable,
    activeThreads: sidebarHeldRows(sortedActive, "active", optimisticDrop, threadShellKey),
    workingThreads: sortWorkingThreadsBySend(working),
    snoozedThreads: snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    ),
    settledThreads: sortSettledThreads(settled),
    customThreads: new Map(
      [...custom].map(([id, list]) => [
        id,
        sidebarHeldRows(
          workingShelfEnabled
            ? sortInboxThreadsByReturn(list, inboxReturns.returnedAt)
            : sortThreadsForSidebar(list),
          customSidebarSection(id),
          optimisticDrop,
          threadShellKey,
        ),
      ]),
    ),
    snoozeNow: preciseNow,
  };
}

// Sidebar() is large enough that the compiler cannot prove its local maps stay
// unmutated; built inside a hook they reach it frozen and cached.
function useSidebarLookups() {
  const projects = useProjects();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const projectGroups = useSidebarProjectGroups();
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );
  const projectGroupByScopeKey = new Map(
    projectGroups.map((project) => [project.projectKey, project] as const),
  );
  const projectScopeItems = [
    { value: "all", label: "All projects" },
    ...projectGroups.map((project) => ({ value: project.projectKey, label: project.displayName })),
  ];
  return {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectScopeItems,
  };
}

function scheduleSnoozeWake(wakeAt: string | null, onWake: () => void): (() => void) | undefined {
  const wakeAtMs = wakeAt === null ? Number.NaN : Date.parse(wakeAt);
  if (Number.isNaN(wakeAtMs)) return undefined;
  // setTimeout delays are signed 32-bit: anything larger overflows and fires
  // immediately, turning a far-future wake (event-condition snoozes synced
  // from elsewhere) into a tight re-arm loop.
  const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
  const id = window.setTimeout(onWake, delayMs);
  return () => window.clearTimeout(id);
}

function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}

/** The snooze gate's thread inputs (`sidebarSnoozeDropAllowed`), built the same way at pickup and
    at release. `capabilities` are those of the thread's server. */
function sidebarSnoozeGateOf(
  thread: SidebarThreadSummary | undefined,
  capabilities: { readonly threadSnooze?: boolean } | undefined,
  now: string,
) {
  return {
    supportsSnooze: thread !== undefined && capabilities?.threadSnooze === true,
    canSnooze: thread !== undefined && canSnooze(thread, { now }),
    canOperate: thread !== undefined && canOperateThreads([thread]),
  };
}

// The empty Snoozed shelf. The li is zero height at rest, so nothing moves at pickup. Its
// sortable node is the hint box, absolutely placed just above the li: dnd-kit measures that 36px
// box, the strategy moves it into the slot it opens, and the collision detector hit-tests it
// where it is painted. Where it may not open in place (`sidebarSnoozeHintState`), the box
// goes `atEnd`: out of flow below everything in the list, positioned against the list itself, so
// the li keeps its place (and its auto margin) and no row moves. The box then carries the
// transform: on the li it would make the li the box's containing block.
function SidebarSnoozedPlaceholder(props: {
  showHint: boolean;
  isDropTarget: boolean;
  firstShelf: boolean;
  atEnd: boolean;
}) {
  const { setNodeRef, transform } = useSortable({
    id: SNOOZED_PLACEHOLDER_ID,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit measured the box where it rested at pickup; a moved box needs a fresh rect or the
  // strategy projects it from the old place.
  const { measureDroppableContainers } = useDndContext();
  const { atEnd } = props;
  useLayoutEffect(() => {
    if (atEnd) measureDroppableContainers([SNOOZED_PLACEHOLDER_ID]);
  }, [atEnd, measureDroppableContainers]);
  const moved = {
    transform: CSS.Translate.toString(transform),
    transition: "none",
    visibility: transform?.scaleY === 0 ? ("hidden" as const) : undefined,
  };
  return (
    <li
      data-thread-selection-safe
      data-testid="sidebar-snoozed-placeholder"
      className={cn(
        "mx-0.5 -mb-px h-0 list-none",
        !atEnd && "relative",
        props.firstShelf && "mt-auto",
      )}
      style={atEnd ? undefined : moved}
    >
      <div
        ref={setNodeRef}
        className={cn(
          "pointer-events-none absolute flex h-9 items-center justify-center rounded-md text-xs",
          atEnd ? "inset-x-0.5 top-full mt-px" : "inset-x-0 bottom-0",
          props.showHint &&
            "border border-dashed border-sidebar-foreground/25 text-sidebar-foreground/80",
          props.showHint && props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
        )}
        style={atEnd ? moved : undefined}
      >
        {props.showHint ? "Snoozed" : null}
      </div>
    </li>
  );
}

// "Show N more" after the Settled rows. It is listed in the sortable context after the rows but can
// be neither lifted nor dropped on: the strategy only moves it with the rows above it.
function SidebarSettledShowMore(props: { count: number; onClick: () => void }) {
  const { setNodeRef, transform, transition } = useSortable({
    id: SHOW_MORE_ID,
    disabled: { draggable: true, droppable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      className="list-none"
      data-testid="sidebar-settled-show-more"
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <button
        type="button"
        onClick={props.onClick}
        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <PlusIcon aria-hidden className="size-4 shrink-0" />
        Show {props.count} more
      </button>
    </li>
  );
}

const SIDEBAR_DRAG_DISTANCE = 6;

const SIDEBAR_DRAG_LABEL_HEIGHT = 24;

/** Measured once per drag, on the pickup layout (after the render that started the drag). */
interface SidebarDragPickup {
  readonly snoozeHint: SidebarSnoozeHint;
  /** The whole Queue block (header and rows) when it renders right above the first shelf. */
  readonly dockedQueueHeight: number | undefined;
  /** From the last row's bottom to the bottom of the content rendered after the rows. */
  readonly trailingHeight: number;
}

const SIDEBAR_SHELF_TEST_IDS = new Set([
  "sidebar-working-header",
  "sidebar-snoozed-header",
  "sidebar-snoozed-placeholder",
  "sidebar-settled-header",
]);

/** Reads the pickup layout for the strategy and the empty-shelf hint. Rects ignore transforms,
 * as dnd-kit's droppable rects do: the Pins labels and the preview move rows by transform only. */
function measureSidebarPickup(
  list: HTMLUListElement | null,
  input: {
    readonly snoozeAllowed: boolean;
    readonly fromQueue: boolean;
    readonly queueAfterRows: boolean;
  },
): SidebarDragPickup {
  const rectOf = (node: Element | null | undefined) =>
    node instanceof HTMLElement ? getClientRect(node, { ignoreTransform: true }) : undefined;
  const queueHeader = list?.querySelector('[data-testid="sidebar-queue-header"]') ?? null;
  // The Queue block runs from its header to the first marker after it; its rows are not markers.
  let afterQueue = queueHeader?.nextElementSibling ?? null;
  while (afterQueue !== null && !afterQueue.hasAttribute("data-thread-selection-safe")) {
    afterQueue = afterQueue.nextElementSibling;
  }
  const docked =
    queueHeader !== null &&
    afterQueue !== null &&
    SIDEBAR_SHELF_TEST_IDS.has(afterQueue.getAttribute("data-testid") ?? "");
  const queueTop = rectOf(queueHeader)?.top;
  const queueBottom = rectOf(afterQueue?.previousElementSibling)?.bottom;
  const placeholder = list?.querySelector('[data-testid="sidebar-snoozed-placeholder"]');
  const scale =
    list !== null && list.offsetWidth > 0
      ? list.getBoundingClientRect().width / list.offsetWidth
      : 1;
  // Content after the last row: the Queue placed after every row, then "Show N more".
  const trailingStart = input.queueAfterRows
    ? queueHeader
    : (list?.querySelector('[data-testid="sidebar-settled-show-more"]') ?? null);
  const lastRow = rectOf(trailingStart?.previousElementSibling);
  const contentEnd = rectOf(list?.lastElementChild);
  return {
    snoozeHint: sidebarSnoozeHintState({
      snoozeAllowed: input.snoozeAllowed,
      hint: rectOf(placeholder?.firstElementChild),
      above: rectOf(placeholder?.previousElementSibling),
      labelsShift: input.fromQueue ? 0 : sidebarDragLabelsShift(SIDEBAR_DRAG_LABEL_HEIGHT, scale),
    }),
    dockedQueueHeight:
      docked && queueTop !== undefined && queueBottom !== undefined
        ? queueBottom - queueTop
        : undefined,
    trailingHeight:
      lastRow !== undefined && contentEnd !== undefined
        ? Math.max(0, contentEnd.bottom - lastRow.bottom)
        : 0,
  };
}

/**
 * The bag the overlay copy renders with: the row's dragging state, none of its wiring. `isDragging`
 * is what suppresses the row's hover tooltip and puts the drop verb and the lifted card on the copy
 * the pointer is carrying rather than on the row parked in the list.
 */
const overlaySortableBag = {
  listeners: undefined,
  setNodeRef: () => {},
  transform: null,
  transition: undefined,
  isDragging: true,
} satisfies QueueRowSortableBag;

/** The thread list's scrollport, whichever ancestor actually scrolls. */
function sidebarScroller(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el !== null; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}

// A user-defined section's header: collapses like a shelf, and its context menu renames or deletes.
function SidebarCustomSectionHeader(props: {
  sectionId: string;
  name: string;
  // Active/total after the name; a long name truncates, the count stays visible.
  count: string;
  dragging: boolean;
  isDropTarget: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
  onContextMenu?: ((position: { x: number; y: number }) => void) | undefined;
}) {
  const { onContextMenu } = props;
  return (
    <SortableSidebarMarker
      item={{
        kind: "marker",
        marker: "custom-header",
        sectionId: props.sectionId,
        collapsed: !props.toggle.expanded,
      }}
      data-testid="sidebar-custom-section-header"
      className="group/section-header relative mx-0.5 h-8"
    >
      <CollapsibleSectionHeader
        title={props.name}
        onClick={props.toggle.onToggle}
        {...(onContextMenu === undefined
          ? {}
          : {
              onContextMenu: (event: ReactMouseEvent) => {
                event.preventDefault();
                onContextMenu({ x: event.clientX, y: event.clientY });
              },
              // Holds the actions button's place: the chevron lines up with the shelves', and a
              // long name truncates before it reaches the button laid over this spacer.
              accessory: <span aria-hidden className="w-5 shrink-0" />,
            })}
        count={props.count}
        expanded={props.toggle.expanded}
        tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
      >
        {props.name}
      </CollapsibleSectionHeader>
      {onContextMenu === undefined ? null : (
        // Touch browsers (iOS Safari) never fire contextmenu, so the same menu sits on a button
        // that is always shown on coarse pointers. right-7 (px-2 + chevron + gap-2) puts it over
        // the spacer, which keeps its 44px coarse tap area off the chevron's centre.
        <div className="pointer-events-none absolute right-7 top-1/2 -translate-y-1/2 opacity-0 group-hover/section-header:pointer-events-auto group-hover/section-header:opacity-100 group-focus-within/section-header:pointer-events-auto group-focus-within/section-header:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label="Section actions"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onContextMenu({ x: rect.left, y: rect.bottom });
            }}
          >
            <EllipsisIcon aria-hidden />
          </Button>
        </div>
      )}
    </SortableSidebarMarker>
  );
}

// A draft waiting in the Queue. Subscribes to its own draft so typing in it
// repaints only this row.
const QueuedDraftRow = memo(function QueuedDraftRow(props: {
  draftId: DraftId;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onToggleQueue: (draftId: DraftId, session: DraftSessionState) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
  sortable: QueueRowSortableBag;
  isOverlayCopy?: boolean | undefined;
}) {
  const session = useComposerDraftStore((store) => store.getDraftSession(props.draftId));
  const composer = useComposerDraftStore((store) => store.getComposerDraft(props.draftId));
  if (!session || !composer || session.promotedTo != null) return null;
  const projectKey = `${session.environmentId}:${session.projectId}`;
  return (
    <SidebarDraftRow
      draftId={props.draftId}
      session={session}
      composer={composer}
      project={props.projectByKey.get(projectKey) ?? null}
      projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
      isActive={props.isActive}
      onNavigate={props.onNavigate}
      onDiscard={discardComposerDraft}
      queued
      onToggleQueue={props.onToggleQueue}
      onContextMenu={props.onContextMenu}
      sortable={props.sortable}
      isOverlayCopy={props.isOverlayCopy}
    />
  );
});

export default function Sidebar() {
  const {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectScopeItems,
  } = useSidebarLookups();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    reorderPinnedThread,
    reorderActiveThread,
    setThreadSidebarSection,
    moveThreadToSidebarSection,
    markThreadUnread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const newThreadContext = useHandleNewThread();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const environmentMachineById = useEnvironmentMachines();
  const projectGroupsRef = useRef(projectGroups);
  const persistedProjectScopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setPersistedProjectScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const allProjectConfigsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  const headerSearchRef = useRef<HTMLDivElement | null>(null);
  // Safari can send a click after Ctrl+click opens settings. Ignore that one
  // selection, then clear the guard when the picker opens again.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [searchHighlight, setSearchHighlight] = useState({ orderKey: "", index: 0 });
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const settlingThreadKeysRef = useRef(new Set<string>());
  const threadListRef = useRef<HTMLUListElement | null>(null);
  const dragLabelOffsetRef = useRef(0);
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const [dragState, setDragState] = useState<
    | (SidebarDragOrigin &
        SidebarDragOverState & {
          readonly occurredAt: string;
          readonly activationY: number | null;
          readonly contextDrag: boolean;
          /** Unset until the pickup layout is measured. */
          readonly pickup?: SidebarDragPickup;
          /** The Queue block's shown entries at pickup; the Queue is placed by it all drag. */
          readonly queueEntryCount: number;
        })
    | null
  >(null);
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const contextDragKeyRef = useRef<string | null>(null);
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const openAddProjectCommandPalette = () => openCommandPalette({ open: "add-project" });
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeThreadKeyRef = useRef(routeThreadKey);

  // A selection made under one scope can hold threads the next scope hides.
  const setProjectScopeKey = (key: string | null) => {
    clearSelection();
    setPersistedProjectScopeKey(key);
  };
  const projectScopeKey = resolveSidebarProjectScopeKey({
    groups: projectGroups,
    key: persistedProjectScopeKey,
    settings: projectGroupingSettings,
  });
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const scratchMachineLabelFor = (
    thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  ) => {
    if (!showProjectEnvironments) return null;
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
    if (
      !project ||
      !isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
    ) {
      return null;
    }
    return environmentLabelById.get(thread.environmentId) ?? null;
  };
  const selectedProjectScopeItem =
    projectScopeItems.find((item) => item.value === (projectScopeKey ?? "all")) ??
    projectScopeItems[0]!;
  const filteredProjectScopeItems = filterSidebarProjectScopeItems({
    items: projectScopeItems,
    query: projectScopeMenuState.query,
    matches: (item, query) =>
      projectScopeFilter.contains(item, query, (candidate) => candidate.label),
  });
  const scopedProjectGroup =
    projectScopeKey === null
      ? null
      : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null);
  const scopedProjectKeys =
    scopedProjectGroup === null
      ? null
      : new Set(
          scopedProjectGroup.memberProjectRefs.map(
            (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
          ),
        );
  useEffect(() => {
    const nextKey = resolveSidebarProjectScopeKey({
      groups: projectGroups,
      key: persistedProjectScopeKey,
      settings: projectGroupingSettings,
      canClearMissingScope: allProjectSnapshotsReady && allProjectConfigsReady,
    });
    if (nextKey !== persistedProjectScopeKey) {
      clearSelection();
      setPersistedProjectScopeKey(nextKey);
    }
  }, [
    allProjectConfigsReady,
    allProjectSnapshotsReady,
    clearSelection,
    persistedProjectScopeKey,
    projectGroups,
    projectGroupingSettings,
    setPersistedProjectScopeKey,
  ]);
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (
        scopedProjectKeys !== null &&
        !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      count += 1;
    }
    return count;
  });

  const openProjectSettings = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey: getSidebarProjectSettingsKey(
            projectGroup,
            projectGroupingSettings,
            projects,
            projectRef,
          ),
        },
      });
    },
  );
  const handleProjectSettings = useStableCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      suppressNextScopeChangeRef.current = true;
      dispatchProjectScopeMenu({ type: "project-settings-opened" });
      openProjectSettings(projectGroup);
    },
  );

  // Queued threads and drafts render under Queue and nowhere else.
  const queueEntries = useThreadQueueStore((state) => state.entries);
  const queueMode = useThreadQueueStore((state) => state.mode);
  const queuedKeys = new Set(queueEntries.map(threadQueueEntryKey));
  const queuedDraftIds = new Set(
    queueEntries.flatMap((entry) => (entry.draftId === null ? [] : [entry.draftId])),
  );
  const [queueExpanded, setQueueExpanded] = useLocalStorage(
    QUEUE_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const toggleQueueExpanded = () => setQueueExpanded((value) => !value);
  const toggleDraftQueue = useStableCallback((draftId: DraftId, session: DraftSessionState) => {
    const store = useThreadQueueStore.getState();
    const key = threadQueueEntryKey({
      environmentId: session.environmentId,
      threadId: session.threadId,
    });
    toggleSidebarDraftQueue({
      queued: store.entries.some((entry) => threadQueueEntryKey(entry) === key),
      remove: () => store.remove(key),
      checkOperate: () => checkThreadOperations([session]),
      enqueue: () => {
        const prompt = useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt ?? "";
        addToQueueOrSayWhy({
          environmentId: session.environmentId,
          threadId: session.threadId,
          draftId,
          // What other devices show for a draft they cannot open: the row's own preview text.
          label: replaceComposerContextReferences(prompt, (occurrence) => occurrence.label),
        });
      },
    });
  });

  // Keep a dropped row at its destination while its server applies the
  // lifecycle command and any order-key writes. The next pickup waits for
  // this hold so a second drop cannot replace an unconfirmed placement.
  const {
    drop: optimisticDrop,
    holdDuring: holdOptimisticDrop,
    release: releaseOptimisticDrop,
  } = useSidebarDropHold();
  const sidebarSections = useSidebarSections();
  const {
    shownQueueEntries,
    customSectionIds,
    threads,
    workingShelfEnabled,
    pinnedThreads,
    draggableThreadKeys,
    activeReorderableThreadKeys,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    customThreads,
    snoozeNow,
    sectionCounts,
    searchableThreads,
    settledVisibleCount,
    hiddenSettledCount,
    showMoreSettled,
    settledShelfExpanded,
    toggleSettledShelf,
    snoozedShelfExpanded,
    toggleSnoozedShelf,
    workingShelfExpanded,
    toggleWorkingShelf,
    collapsedCustomSectionIds,
    toggleCustomSection,
    renderedSettledThreads,
    visibleSnoozedThreads,
    visibleWorkingThreads,
    visibleCustomThreads,
    orderedThreadKeys,
    threadByKey,
    settledThreadKeys,
    snoozedThreadKeys,
    sectionByThreadKey,
    pinnedKeys,
    activeKeys,
    customOrderKeys,
    pinnedKeysById,
    activeKeysById,
    routeRowThreadKey,
  } = useSidebarThreads({
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    routeThreadRef,
    queueEntries,
    sidebarSections,
    queueExpanded,
  });
  const isQueueEntryActive = useStableCallback((entry: ThreadQueueEntry) =>
    sectionCounts.activeQueuedKeys.has(threadQueueEntryKey(entry)),
  );

  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const threadSearchMatchByKey = new Map(
    threadSearch.matches.map((match) => [threadSearchMatchKey(match), match] as const),
  );
  const threadSearchResults = searchSidebarThreads(
    searchableThreads,
    threadSearchQuery,
    new Set(threadSearchMatchByKey.keys()),
  );
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    .join("\0");

  // The highlight belongs to one result list; a new list starts at the top.
  const activeSearchResultIndex =
    searchHighlight.orderKey === threadSearchResultOrderKey ? searchHighlight.index : 0;
  const setActiveSearchResultIndex = (index: number | ((index: number) => number)) =>
    setSearchHighlight((current) => {
      const currentIndex = current.orderKey === threadSearchResultOrderKey ? current.index : 0;
      return {
        orderKey: threadSearchResultOrderKey,
        index: typeof index === "function" ? index(currentIndex) : index,
      };
    });
  const activeSearchResult = isSearchingThreads
    ? threadSearchResults[activeSearchResultIndex]
    : undefined;
  const activeSearchResultKey =
    activeSearchResult === undefined
      ? null
      : scopedThreadKey(scopeThreadRef(activeSearchResult.environmentId, activeSearchResult.id));
  useEffect(() => {
    if (activeSearchResultKey === null) return;
    document
      .querySelector(`[data-search-result-key="${globalThis.CSS.escape(activeSearchResultKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultKey]);

  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  const settledThreadKeysRef = useRef(settledThreadKeys);
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);

  const jumpLabelByKey = (() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  })();
  const { showThreadJumpHints: showJumpHints, updateThreadJumpHintsVisibility } =
    useThreadJumpHintVisibility();

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
    const dropId = queuePendingFileDrop({ threadRef, files });
    const landedBefore =
      router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname === router.state.location.pathname;
    if (landedBefore) return;

    try {
      await navigateToThread(threadRef);
      const landed =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (!landed) clearPendingFileDrop(dropId);
    } catch {
      clearPendingFileDrop(dropId);
    }
  };

  const navigateToDraft = (draftId: DraftId) => {
    clearSelection();
    if (isMobile) {
      setOpenMobile(false);
    }
    void router.navigate({ to: "/draft/$draftId", params: { draftId } });
  };

  const clearThreadSearch = () => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  };
  const selectThreadSearchResult = (thread: EnvironmentThreadShell) => {
    clearThreadSearch();
    navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
  };
  const handleThreadSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearchingThreads) {
      event.preventDefault();
      event.stopPropagation();
      clearThreadSearch();
      return;
    }
    if (threadSearchResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSearchResultIndex(
        (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = threadSearchResults[activeSearchResultIndex];
      if (result) selectThreadSearchResult(result);
    }
  };

  const startThreadRename = (threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  };
  const cancelThreadRename = () => setRenamingThreadKey(null);
  const commitThreadRename = (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
    void (async () => {
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      const trimmed = title.trim();
      setRenamingThreadKey(null);
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (trimmed === originalTitle) return;
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, title: trimmed },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadClick = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
    if (isSidebarNestedLinkClick(event.target)) return;
    const isMac = isMacPlatform(navigator.platform);
    const isModClick = isMac ? event.metaKey : event.ctrlKey;
    const threadKey = scopedThreadKey(threadRef);
    if (isModClick) {
      event.preventDefault();
      toggleThreadSelection(threadKey);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeysRef.current);
      return;
    }
    if (isTrailingDoubleClick(event.detail)) {
      return;
    }
    navigateToThread(threadRef);
  };

  // Callers snapshot the plan BEFORE the command mutates the partition;
  // background parks never navigate (null plan).
  const planForwardNavigation = (
    threadKey: string,
    coParkingKeys?: ReadonlySet<string>,
  ): (() => void) | null => {
    if (routeThreadKeyRef.current !== threadKey) return null;
    const shell = threadByKeyRef.current.get(threadKey);
    const orderedKeys = orderedThreadKeysRef.current;
    const settledKeys = settledThreadKeysRef.current;
    const snoozedKeys = snoozedThreadKeysRef.current;
    const currentIndex = orderedKeys.indexOf(threadKey);
    const nextCardKey =
      currentIndex === -1
        ? null
        : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
            (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
          ) ?? null);
    const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
    return nextThread
      ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
      : shell
        ? () =>
            void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
        : () => void router.navigate({ to: "/" });
  };

  const attemptSettle = (
    threadRef: ScopedThreadRef,
    opts: { coSettlingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const threadKey = scopedThreadKey(threadRef);
      if (settlingThreadKeysRef.current.has(threadKey)) return;
      settlingThreadKeysRef.current.add(threadKey);
      const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
      const result = await settleThread(threadRef);
      settlingThreadKeysRef.current.delete(threadKey);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (
        shouldNavigateAfterThreadPark({
          threadKey,
          currentThreadKey: routeThreadKeyRef.current,
          action: "settle",
          now: new Date().toISOString(),
          thread: readThreadShell(threadRef),
        })
      ) {
        navigateAfterSettle?.();
      }
    })();
  };
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  const settleThreads = (threadKeys: readonly string[]) => {
    const coSettlingKeys = new Set(threadKeys);
    for (const threadKey of threadKeys) {
      const thread = threadByKeyRef.current.get(threadKey);
      if (!thread || thread.settledOverride === "settled") continue;
      attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
    }
  };
  const attemptUnsettle = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsettleThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnsnooze = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsnoozeThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  /** A scrolling list has no slack to collapse into: shortening it would clamp the scroll offset
   * and slide every row, the picked-up one included, out from under the pointer. */
  const [listScrolls, setListScrolls] = useState(false);
  const restrictBelowPins: Modifier = (args) =>
    restrictBelowSidebarLabel(args, dragLabelOffsetRef.current);
  // A new array re-renders DndContext and with it every sortable row.
  const dndModifiers = [
    restrictToVerticalAxis,
    restrictBelowPins,
    restrictToFirstScrollableAncestor,
  ];
  const attachListMotionRef = (node: HTMLUListElement | null) => {
    threadListRef.current = node;
    listMotionRef.current?.dispose();
    listMotionRef.current = node === null ? null : createSidebarListMotion(node);
    listMotionRef.current?.update(false);
  };

  // Working rows can supply chat context, but never preview sidebar movement.
  const isContextDrag = dragState?.contextDrag === true || dragState?.activeSection === "working";
  const dragTargetSection = isContextDrag ? null : (dragState?.targetSection ?? null);
  const finishThreadDrag = (started: boolean) => {
    dragSensorRef.current = null;
    contextDragKeyRef.current = null;
    endThreadContextDrag();
    if (started) {
      listMotionRef.current?.release();
      setDragState(null);
    }
  };
  const attachDragSensor = (sensor: SidebarPointerSensor) => {
    dragSensorRef.current = sensor;
  };
  const cancelThreadDrag = () => {
    dragSensorRef.current?.cancel();
  };
  const contextDragThreads = (): ReadonlyArray<ScopedThreadRef> => {
    const key = contextDragKeyRef.current;
    if (key === null) return [];
    const selected = useThreadSelectionStore.getState().selectedThreadKeys;
    const keys = selected.has(key) ? [...selected] : [key];
    return keys.flatMap((candidate) => {
      const ref = parseScopedThreadKey(candidate);
      return ref ? [ref] : [];
    });
  };
  const pointerOutsideThreadList = (point: { x: number; y: number }) => {
    const bounds = threadListRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  };
  const moveThreadContextDrag = (point: { x: number; y: number }) => {
    const contextDrag = pointerOutsideThreadList(point);
    setDragState((current) =>
      current === null || current.contextDrag === contextDrag
        ? current
        : { ...current, contextDrag },
    );
    if (!contextDrag) {
      endThreadContextDrag();
      return false;
    }
    const threads = contextDragThreads();
    const title =
      threadByKeyRef.current.get(contextDragKeyRef.current ?? "")?.title.trim() || "Thread";
    moveThreadContextDragGhost(point, { title, count: threads.length });
    return true;
  };
  const dropThreadContextDrag = (point: { x: number; y: number }) => {
    if (!pointerOutsideThreadList(point)) return false;
    dropThreadContext(point, contextDragThreads());
    // Releasing outside the list never reorders, whether or not a composer took the drop.
    return true;
  };
  // useSensor memoizes on the options object; a fresh one each render rebuilds
  // the sensors, and with them DndContext and every sortable row.
  const pointerSensorOptions = {
    distance: SIDEBAR_DRAG_DISTANCE,
    onAttach: attachDragSensor,
    onFinish: finishThreadDrag,
    onMove: moveThreadContextDrag,
    onDrop: dropThreadContextDrag,
  };
  const dndSensors = useSensors(useSensor(SidebarPointerSensor, pointerSensorOptions));
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  useLayoutEffect(() => {
    routeThreadKeyRef.current = routeThreadKey;
    projectGroupsRef.current = projectGroups;
    orderedThreadKeysRef.current = orderedThreadKeys;
    threadByKeyRef.current = threadByKey;
    handleNewThreadRef.current = newThreadContext.handleNewThread;
    settledThreadKeysRef.current = settledThreadKeys;
    snoozedThreadKeysRef.current = snoozedThreadKeys;
    sectionByThreadKeyRef.current = sectionByThreadKey;
  });
  const startActionSweep = useStableCallback(
    (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
      const originKey = scopedThreadKey(threadRef);
      const originSection = sectionByThreadKeyRef.current.get(originKey);
      const canApply = (key: string) => {
        const thread = threadByKeyRef.current.get(key);
        const capabilities =
          thread && serverConfigs.get(thread.environmentId)?.environment.capabilities;
        return (
          thread !== undefined &&
          sectionByThreadKeyRef.current.get(key) === originSection &&
          (action === "unsnooze"
            ? capabilities?.threadSnooze === true
            : capabilities?.threadSettlement === true)
        );
      };
      let targetKey: string | null = null;
      let sweptKeys: string[] = [];
      const sweepTo = (key: string | null) => {
        if (key === null || key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(orderedThreadKeysRef.current, originKey, key, canApply);
        setActionSweep({ action, keys: new Set(sweptKeys) });
      };
      dragSensorRef.current = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            dragSensorRef.current = null;
            setActionSweep(null);
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) =>
          sweepTo(threadListRef.current && sidebarThreadKeyAtY(threadListRef.current, y)),
        onEnd: () => {
          const keys = sweptKeys.filter(canApply);
          if (action === "settle") {
            settleThreads(keys);
            return;
          }
          for (const key of keys) {
            const ref = parseScopedThreadKey(key);
            if (ref === null) continue;
            if (action === "unsettle") attemptUnsettle(ref);
            else attemptUnsnooze(ref);
          }
        },
        onCancel: () => {},
        onAbort: () => {},
      });
    },
  );
  useEffect(() => {
    if (optimisticDrop === null) return;
    const canonicalByKey = new Map(
      threads.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        thread,
      ]),
    );
    const thread = canonicalByKey.get(optimisticDrop.key);
    const destinationKeys = sidebarDropDestinationKeys(optimisticDrop.section, {
      pinnedOrder: pinnedKeys,
      activeOrder: activeKeys,
      customOrders: customOrderKeys,
    });
    const keyByThread = new Map(
      destinationKeys.flatMap((key) => {
        const canonical = canonicalByKey.get(key);
        return canonical === undefined
          ? []
          : [
              [
                key,
                (optimisticDrop.section === "pinned"
                  ? canonical.pinOrderKey
                  : canonical.activeOrderKey) ?? null,
              ] as const,
            ];
      }),
    );
    if (
      shouldReleaseOptimisticDrop({
        drop: optimisticDrop,
        thread,
        now: new Date().toISOString(),
        customSectionIds,
        destinationKeys,
        keyByThread,
        queued: queuedKeys.has(optimisticDrop.key),
      })
    ) {
      releaseOptimisticDrop();
    }
  }, [
    activeKeys,
    customOrderKeys,
    customSectionIds,
    optimisticDrop,
    pinnedKeys,
    queuedKeys,
    releaseOptimisticDrop,
    threads,
  ]);
  const attemptPin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      // Fresh pins take the top of the arranged run: pinThread computes a
      // key before the smallest key across ALL pinned shells — including
      // snoozed pins hidden from this list, whose keys are still part of
      // the run — so the new pin can't land beneath a hidden head.
      const result = await pinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to pin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnpin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await confirmAndUnpinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unpin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  // dnd-kit decides `over` on the last pointermove and reuses it at release. The sidebar list sits
  // within a pixel of its scroll threshold, so a row flipping between its content-visibility
  // intrinsic size and its real height can scroll the list a couple of pixels between that event
  // and the mouseup - and the stored `over` then describes a layout the user never released over.
  // Keep the real pointer so the drop can be resolved against what is on screen at release.
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (dragState === null) {
      dragPointerRef.current = null;
      return;
    }
    const track = (event: PointerEvent) => {
      // Only the pointer that started this drag may steer it. A second finger resting on a
      // touchscreen, or a hovering pen, also emits pointermove over the sidebar, and without this
      // it would decide where the drag lands: measured 8/8 drops hijacked into the Queue by a
      // foreign pointer merely crossing the header, against 0/8 for the same gesture alone. The
      // sensor filters on pointerId for the same reason.
      // Fail CLOSED: with no id captured there is no own pointer to trust, so record nothing and
      // let `over` decide, rather than accepting whichever pointer moved last. Unreachable while
      // the only sensor is pointer-driven; adding a keyboard sensor would otherwise re-open the
      // hijack silently.
      if (dragPointerIdRef.current === null || event.pointerId !== dragPointerIdRef.current) return;
      dragPointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", track, { capture: true });
    return () => window.removeEventListener("pointermove", track, { capture: true });
  }, [dragState]);

  const handleThreadDragStart = (event: DragStartEvent) => {
    const activeKey = String(event.active.id);
    if (sidebarPickupRefused(activeKey, optimisticDrop)) return;
    contextDragKeyRef.current = activeKey;
    const fromQueue = queuedKeys.has(activeKey);
    const queuedThread = fromQueue ? threadByKey.get(activeKey) : undefined;
    const activeSection = !fromQueue
      ? sectionByThreadKey.get(activeKey)
      : queuedThread === undefined
        ? "active"
        : sidebarRestingSection(
            queuedThread,
            serverConfigs.get(queuedThread.environmentId)?.environment.capabilities,
            new Date().toISOString(),
            customSectionIds,
          );
    if (activeSection === undefined) return;
    // Stop normal section motion before dnd-kit measures the picked-up row.
    listMotionRef.current?.suspend();
    setListScrolls(sidebarScroller(threadListRef.current) !== null);
    const list = threadListRef.current;
    const header = list?.querySelector<HTMLElement>('[data-testid="sidebar-pinned-header"]');
    if (list && header) {
      const listRect = list.getBoundingClientRect();
      const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
      dragLabelOffsetRef.current =
        header.getBoundingClientRect().top - listRect.top + SIDEBAR_DRAG_LABEL_HEIGHT * scale;
    } else {
      dragLabelOffsetRef.current = 0;
    }
    dragPointerIdRef.current =
      event.activatorEvent instanceof PointerEvent ? event.activatorEvent.pointerId : null;
    setDragState({
      activeKey,
      activeSection,
      fromQueue,
      queuedDraft: fromQueue && queuedThread === undefined,
      // A Queue row targets nothing until it moves: dropped where it was, it stays queued.
      targetSection: fromQueue ? null : activeSection,
      overZone: null,
      // A first over on a snooze zone projects as the row's own slot, not as "no over".
      stickyOverId: activeKey,
      contextDrag: false,
      queueEntryCount: shownQueueEntries.length,
      occurredAt: new Date().toISOString(),
      activationY:
        event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
    });
  };
  // Include every visible row in the measured order. Older servers disable
  // pickup on their rows without changing where those rows render.
  const keysOf = (list: readonly EnvironmentThreadShell[]) =>
    list.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
  const sidebarListItemsFresh = buildSidebarListItems({
    pinned: keysOf(pinnedThreads),
    active: keysOf(activeThreads),
    working: { total: workingThreads.length, visible: keysOf(visibleWorkingThreads) },
    snoozed: { total: snoozedThreads.length, visible: keysOf(visibleSnoozedThreads) },
    settled: { total: settledThreads.length, visible: keysOf(renderedSettledThreads) },
    custom: visibleCustomThreads.map((block) => ({
      id: block.section.id,
      visible: keysOf(block.visible),
      collapsed: collapsedCustomSectionIds.includes(block.section.id),
    })),
  });
  // Thread shells update on every streamed event without moving rows. Keep the
  // list's identity until its order changes, so the sorting strategy, the
  // sortable context and every sortable row stay memoized meanwhile.
  const sidebarListItemsKey = sidebarListItemsFresh
    .map((item) =>
      item.kind === "thread"
        ? item.section + ":" + item.key
        : item.marker === "custom-header"
          ? `${item.marker}:${item.sectionId}:${item.collapsed ? "collapsed" : "open"}`
          : item.marker,
    )
    .join("\n");
  const [sidebarListItemsState, setSidebarListItems] = useState(sidebarListItemsFresh);
  const [sidebarListItemsKeyState, setSidebarListItemsKeyState] = useState(sidebarListItemsKey);
  let sidebarListItems = sidebarListItemsState;
  if (sidebarListItemsKeyState !== sidebarListItemsKey) {
    setSidebarListItemsKeyState(sidebarListItemsKey);
    setSidebarListItems(sidebarListItemsFresh);
    // The rest of this render still runs before React applies the update, and
    // threadByKey already lacks rows that just left, such as a thread settled
    // into the collapsed Settled shelf.
    sidebarListItems = sidebarListItemsFresh;
  }
  useEffect(() => {
    if (
      dragState !== null &&
      sidebarDragLostItsRow(dragState.activeKey, sidebarListItems, queuedKeys)
    ) {
      cancelThreadDrag();
    }
  }, [cancelThreadDrag, dragState, queuedKeys, sidebarListItems]);
  // Rows only move when the rendered order, a row's section, or the draft block
  // changes. Running the motion pass on that alone keeps ordinary shell events
  // from forcing a layout read and animating rows that drifted for other reasons.
  const listMotionLayoutKey = [
    sidebarListItemsKey,
    visibleDraftSessionCount,
    routeDraftIdForRows ?? "",
  ].join("\0");
  const listMotionAnimate =
    dragState === null && sidebarListItems.length + visibleDraftSessionCount > 0;
  // The effect reads only `animate`; the pass object is cached on both fields,
  // so a new layout key alone also triggers it.
  const listMotionPass = { layoutKey: listMotionLayoutKey, animate: listMotionAnimate };
  useLayoutEffect(() => {
    listMotionRef.current?.update(listMotionPass.animate);
  }, [listMotionPass]);
  const draggedKey = dragState?.activeKey;
  const draggedSection = dragState?.activeSection;
  const draggedFromQueue = dragState?.fromQueue ?? false;
  const draggedQueuedDraft = dragState?.queuedDraft ?? false;
  const dragOrigin: SidebarDragOrigin | null =
    draggedKey === undefined || draggedSection === undefined
      ? null
      : {
          activeKey: draggedKey,
          activeSection: draggedSection,
          fromQueue: draggedFromQueue,
          queuedDraft: draggedQueuedDraft,
        };
  const dragListItems = sidebarDragListItems(sidebarListItems, dragOrigin);
  // The Snoozed shelf's zones for the lifted row, or null when it may not be snoozed there.
  const snoozeZoneIds = (() => {
    if (dragOrigin === null) return null;
    const source = threadByKey.get(dragOrigin.activeKey);
    const allowed = sidebarSnoozeDropAllowed({
      drag: dragOrigin,
      ...sidebarSnoozeGateOf(
        source,
        source === undefined
          ? undefined
          : serverConfigs.get(source.environmentId)?.environment.capabilities,
        new Date().toISOString(),
      ),
    });
    return allowed ? sidebarSnoozeZoneIds(dragListItems, dragOrigin.activeKey) : null;
  })();
  const snoozeAllowed = snoozeZoneIds !== null;
  const snoozeZoneSet = snoozeZoneIds === null ? null : new Set(snoozeZoneIds);
  const dragStickyOverId = dragState?.stickyOverId ?? null;
  const dragPickup = dragState?.pickup;
  const snoozeHint = dragPickup?.snoozeHint ?? "closed";
  // Where the Queue renders this drag, and whether it collapses to its header.
  const queuePlacement = sidebarQueuePlacement({
    sectionCount: (sidebarSections ?? []).length,
    entryCount: sidebarDragQueueEntryCount(dragState?.queueEntryCount, shownQueueEntries),
    dropShown: !isContextDrag && dragOrigin !== null && !dragOrigin.fromQueue,
    listScrolls,
    liftedFromShelf:
      dragOrigin !== null &&
      !dragOrigin.fromQueue &&
      (dragOrigin.activeSection === "snoozed" || dragOrigin.activeSection === "settled"),
  });
  const queueBoundary = sidebarQueueBoundary(queuePlacement);
  // Once per drag, on the layout the pickup render committed: the docked Queue appears or
  // collapses at pickup, so measuring before it reads the wrong neighbours. Kept in the drag
  // state so the hint's place cannot flip mid-drag.
  const pickupPending = dragState !== null && dragState.pickup === undefined;
  const pickupFromQueue = dragOrigin?.fromQueue === true;
  const queueAfterRows = queuePlacement.belowShelves;
  useLayoutEffect(() => {
    if (!pickupPending) return;
    const pickup = measureSidebarPickup(threadListRef.current, {
      snoozeAllowed,
      fromQueue: pickupFromQueue,
      queueAfterRows,
    });
    setDragState((current) =>
      current === null || current.pickup !== undefined ? current : { ...current, pickup },
    );
  }, [pickupFromQueue, pickupPending, queueAfterRows, snoozeAllowed]);
  const handleThreadDragOver = (event: DragOverEvent) => {
    const overId = event.over ? String(event.over.id) : null;
    // Resolve against the updater's state: the first move can arrive before
    // the render that learned this drag started in the Queue.
    setDragState((current) =>
      current === null || current.activeKey !== String(event.active.id)
        ? current
        : {
            ...current,
            ...nextSidebarDragOver({
              current,
              overId,
              activeKey: current.activeKey,
              items: sidebarDragListItems(sidebarListItems, current),
              queuedKeys,
              queueDropId: QUEUE_DROP_ID,
            }),
          },
    );
  };
  // The Queue header and "Show N more" join the context after the rows (`sidebarSortableIds`).
  const sortableIds = sidebarSortableIds(sidebarListItems, QUEUE_DROP_ID);
  // Outside a drag the orders are constants, so the strategy, and with it
  // every sortable row, keeps its identity while thread shells stream in. A
  // Queue row never previews in the main list, so it needs no orders either.
  // Working beta: the inbox is time-ordered too, so the preview shows the
  // slot a drop will land in, not the slot under the pointer.
  const { settledOrder: draggedSettledOrder, activeOrder: draggedActiveOrder } =
    dragState === null || dragState.fromQueue
      ? NO_DRAGGED_ORDERS
      : resolveDraggedOrders({
          drag: dragState,
          threadByKey,
          settledThreads,
          activeThreads,
          workingShelfEnabled,
        });
  const sidebarSortingStrategy = createSidebarSortingStrategy({
    items: sidebarListItems,
    enabled: !isContextDrag,
    boundaryLabelHeight: SIDEBAR_DRAG_LABEL_HEIGHT,
    settledOrder: draggedSettledOrder,
    ...(draggedActiveOrder === undefined ? {} : { activeOrder: draggedActiveOrder }),
    settledExpanded: settledShelfExpanded,
    settledVisibleCount,
    routeThreadKey: routeRowThreadKey,
    snoozedThreadCount: snoozedThreads.length,
    ...(dragPickup?.dockedQueueHeight === undefined
      ? {}
      : { dockedQueueHeight: dragPickup.dockedQueueHeight }),
    trailingHeight: dragPickup?.trailingHeight ?? 0,
    queueBoundary,
    ...sidebarStrategyDragInput({
      stickyOverId: dragStickyOverId,
      snoozeZoneIds: snoozeZoneSet,
      hint: snoozeHint,
    }),
  });
  const dragActivationY = dragState?.activationY;
  // Hidden and filtered threads keep their keys (`pinnedKeysById`, `activeKeysById`). Reserve
  // those slots without including the rows in the visible drop order or writing to them.
  const dropBoard: SidebarDropBoard = {
    pinnedOrder: pinnedKeys,
    pinnedKeysById,
    reorderableKeys: draggableThreadKeys,
    activeOrder: activeKeys,
    activeKeysById,
    activeReorderableKeys: activeReorderableThreadKeys,
    activeTimeOrdered: workingShelfEnabled,
    customSectionIds,
    customOrders: customOrderKeys,
  };
  const dndCollisionDetection = (() => {
    if (dragOrigin === null) return createSidebarCollisionDetection(() => true);
    const source = threadByKey.get(dragOrigin.activeKey);
    if (source === undefined && !dragOrigin.queuedDraft) {
      return createSidebarCollisionDetection(() => false);
    }
    // Built once per drag, not per candidate on every pointer move.
    const capabilities =
      source === undefined
        ? undefined
        : serverConfigs.get(source.environmentId)?.environment.capabilities;
    const planSource =
      source === undefined
        ? undefined
        : {
            ...source,
            supportsSettlement: capabilities?.threadSettlement === true,
            supportsSections: capabilities?.threadSidebarSections === true,
          };
    return createSidebarCollisionDetection(
      (id) =>
        isSidebarDragCandidate({
          id,
          drag: dragOrigin,
          items: dragListItems,
          queuedKeys,
          queueDropId: QUEUE_DROP_ID,
          snoozeAllowed,
          planKind: (target) =>
            planSource === undefined
              ? "none"
              : planSidebarThreadDrop(
                  sidebarDropPlanInput(dropBoard, dragOrigin, planSource, target),
                ).kind,
        }),
      {
        items: dragListItems,
        activationY: dragActivationY ?? null,
        // Zones are hit where painted, before the gate, so a refused row gets none of them. The
        // empty shelf's box is one only while its hint shows.
        ...(dragOrigin.queuedDraft
          ? {}
          : {
              pointerDropIds: [
                QUEUE_DROP_ID,
                ...(snoozeZoneIds ?? []).filter(
                  (id) => id !== SNOOZED_PLACEHOLDER_ID || snoozeHint !== "closed",
                ),
              ],
            }),
        // Queue rows only take part in a drag that started in the Queue.
        ...(dragOrigin.fromQueue ? { freeIds: [...queuedKeys] } : { excludeIds: [...queuedKeys] }),
      },
    );
  })();
  const performSnooze = async (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    if (snoozingThreadKeysRef.current.has(threadKey)) {
      return { status: "skipped" } as const;
    }
    snoozingThreadKeysRef.current.add(threadKey);
    const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
    const result = await snoozeThread(threadRef, preset.snoozedUntil);
    snoozingThreadKeysRef.current.delete(threadKey);
    if (result._tag === "Failure") {
      return isAtomCommandInterrupted(result)
        ? ({ status: "interrupted" } as const)
        : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
    }
    if (
      shouldNavigateAfterThreadPark({
        threadKey,
        currentThreadKey: routeThreadKeyRef.current,
        action: "snooze",
        now: new Date().toISOString(),
        thread: readThreadShell(threadRef),
      })
    ) {
      navigateAfterSnooze?.();
    }
    return { status: "success" } as const;
  };
  const attemptSnooze = (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const outcome = await performSnooze(threadRef, preset, opts);
      if (outcome.status === "failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to snooze thread",
            description:
              outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
          }),
        );
        return;
      }
    })();
  };
  const handleThreadDragEnd = (event: DragEndEvent) => {
    const activeKey = String(event.active.id);
    // Drag start recorded where the row came from; a drag it ignored has nothing to drop.
    const drag = dragState?.activeKey === activeKey ? dragState : null;
    if (drag === null) return;
    // A release inside the Queue header enqueues, whatever `over` was left holding. Additive on
    // purpose: it rescues a drop the pointer was visibly inside and never redirects one away.
    const pointer = dragPointerRef.current;
    const headerNode =
      drag.fromQueue || drag.queuedDraft
        ? null
        : threadListRef.current?.querySelector<HTMLElement>('[data-testid="sidebar-queue-header"]');
    const headerRect = headerNode?.getBoundingClientRect() ?? null;
    // Same visibility rule as the collision detector: a release only counts where the header is
    // actually painted, never where it is merely laid out beyond its scroller's clip.
    const releasedOverQueue =
      pointer !== null &&
      headerRect !== null &&
      headerNode != null &&
      pointerOverVisibleRect(headerNode, headerRect, pointer);
    const activeThread = threadByKey.get(activeKey);
    const capabilities =
      activeThread === undefined
        ? undefined
        : serverConfigs.get(activeThread.environmentId)?.environment.capabilities;
    const now = new Date().toISOString();
    // Where the thread rests now: a peer may have moved it while it was lifted.
    const { liveSection, snoozeAllowed } = sidebarReleaseSnoozeState({
      drag,
      listedSection: sectionByThreadKey.get(activeKey),
      restingSection:
        activeThread === undefined
          ? undefined
          : sidebarRestingSection(activeThread, capabilities, now, customSectionIds),
      ...sidebarSnoozeGateOf(activeThread, capabilities, now),
    });
    const route = routeSidebarDragEnd({
      drag,
      overId: releasedOverQueue
        ? QUEUE_DROP_ID
        : event.over === null
          ? null
          : String(event.over.id),
      items: sidebarDragListItems(sidebarListItems, drag),
      queuedKeys,
      queueDropId: QUEUE_DROP_ID,
      queueWritable: !useThreadQueueStore.getState().readOnly,
      snoozeAllowed,
    });
    const queue = useThreadQueueStore.getState();
    const entryIndex = (key: string) =>
      queue.entries.findIndex((entry) => threadQueueEntryKey(entry) === key);
    if (route.kind === "none") return;
    if (route.kind === "reorder-queue") {
      const entry = queue.entries[entryIndex(activeKey)];
      const toIndex = entryIndex(route.overKey);
      if (entry !== undefined && toIndex >= 0) queue.enqueue(entry, toIndex);
      return;
    }
    if (activeThread === undefined) return;
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const queueEntry = {
      environmentId: activeThread.environmentId,
      threadId: activeThread.id,
      draftId: null,
      label: activeThread.title,
    };
    const errorToast = (title: string) => (error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    const run = async (operation: Promise<AtomCommandResult<unknown, unknown>>, title: string) => {
      const result = await operation;
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) errorToast(title)(squashAtomCommandFailure(result));
      return false;
    };
    if (route.kind === "enqueue") {
      void runSidebarEnqueueDrop({
        liveSection,
        checkOperate: () => checkThreadOperations([activeThread]),
        enqueue: () => addToQueueOrSayWhy(queueEntry),
        wake: () => run(unsnoozeThread(threadRef), "Failed to wake thread"),
      });
      return;
    }
    if (route.kind === "snooze") {
      void runSidebarSnoozeDrop({
        drag,
        liveSection,
        checkOperate: () => checkThreadOperations([activeThread]),
        snooze: (snoozedUntil) => performSnooze(threadRef, { snoozedUntil }),
        unqueue: () => useThreadQueueStore.getState().remove(activeKey),
        reportFailure: errorToast("Failed to snooze thread"),
      });
      return;
    }
    const { target } = route;
    // A main-list row re-reads its section: it may have moved while lifted.
    const activeSection = drag.fromQueue
      ? drag.activeSection
      : (sectionByThreadKey.get(activeKey) ?? drag.activeSection);
    const plan = planSidebarThreadDrop(
      sidebarDropPlanInput(
        dropBoard,
        { activeKey, activeSection, fromQueue: drag.fromQueue },
        {
          ...activeThread,
          supportsSettlement: capabilities?.threadSettlement === true,
          supportsSections: capabilities?.threadSidebarSections === true,
        },
        target,
      ),
    );
    const unqueue = sidebarDropUnqueue(route.unqueue, plan);
    const assignments =
      plan.kind === "pin"
        ? [
            ...(plan.orderKey === undefined ? [] : [{ id: activeKey, orderKey: plan.orderKey }]),
            ...plan.extraAssignments,
          ]
        : plan.kind === "reorder-pinned" || plan.kind === "move-active"
          ? plan.assignments
          : [];
    if (
      !startSidebarPlaceDrop({
        plan,
        unqueue,
        settling: settlingThreadKeysRef.current.has(activeKey),
        // A drop rewrites the dragged row and every row it renumbers, so all of
        // them must be writable before any of them changes.
        checkOperate: () =>
          checkThreadOperations(
            [activeKey, ...assignments.map(({ id }) => id)].flatMap((key) => {
              const thread = threadByKey.get(key);
              return thread ? [thread] : [];
            }),
          ),
        removeFromQueue: () => queue.remove(activeKey),
        reportRefusal: (reason) =>
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Can't place thread here",
              description: reason,
            }),
          ),
      }) ||
      // Unreachable once started; narrows `plan`.
      plan.kind === "none" ||
      plan.kind === "refuse"
    )
      return;
    // A renumbered row that vanished meanwhile is skipped, not a failure.
    const reorder =
      (command: typeof reorderActiveThread | typeof reorderPinnedThread, title: string) =>
      async (threadKey: string, orderKey: string) => {
        const thread = threadByKey.get(threadKey);
        return thread === undefined
          ? true
          : run(command(scopeThreadRef(thread.environmentId, thread.id), orderKey), title);
      };
    const commands: SidebarDropCommands = {
      settle: async () => {
        settlingThreadKeysRef.current.add(activeKey);
        const navigateAfterSettle = planForwardNavigation(activeKey);
        const settled = await run(settleThread(threadRef), "Failed to settle thread").finally(() =>
          settlingThreadKeysRef.current.delete(activeKey),
        );
        if (
          settled &&
          shouldNavigateAfterThreadPark({
            threadKey: activeKey,
            currentThreadKey: routeThreadKeyRef.current,
            action: "settle",
            now: new Date().toISOString(),
            thread: readThreadShell(threadRef),
          })
        )
          navigateAfterSettle?.();
        return settled;
      },
      clearSection: () =>
        run(setThreadSidebarSection(threadRef, null), "Failed to move thread to Active"),
      // The drag expresses unpin intent; button/menu confirmation is unchanged.
      unpin: () => run(unpinThread(threadRef), "Failed to unpin thread"),
      unsettle: () => run(unsettleThread(threadRef), "Failed to un-settle thread"),
      unsnooze: () => run(unsnoozeThread(threadRef), "Failed to wake thread"),
      pin: (orderKey) =>
        run(
          pinThread(threadRef, orderKey === undefined ? {} : { orderKey }),
          "Failed to pin thread",
        ),
      reorderActive: reorder(reorderActiveThread, "Failed to reorder active threads"),
      reorderPinned: reorder(reorderPinnedThread, "Failed to reorder pinned threads"),
      joinSection: (sectionId) =>
        moveThreadToSidebarSection(
          threadRef,
          sectionId,
          sidebarSections?.find((section) => section.id === sectionId)?.name ?? sectionId,
        ),
      joined: () => {
        if (unqueue === "on-join") useThreadQueueStore.getState().remove(activeKey);
      },
    };
    // A queued member that only unparks never leaves its section, so nothing is held.
    if (plan.kind === "unpark") {
      void runSidebarDropCommands(plan, commands);
      return;
    }
    const drop = sidebarOptimisticDrop({
      key: activeKey,
      sourceSection: activeSection,
      section: target.section,
      plan,
      assignments,
      occurredAt: new Date().toISOString(),
      pinnedKeysById,
      activeKeysById,
    });
    void holdSidebarDrop(holdOptimisticDrop, drop, plan, commands, unqueue);
  };

  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const settlingThreads = selectedThreads.filter(
        (thread) => thread.settledOverride !== "settled",
      );
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread, { now: selectionNow.toISOString() }),
      );
      const titleRegenerationThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true,
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const pinnedSelectedThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning ===
            true && thread.pinnedAt != null,
      );
      const unpinMenuItem = buildBulkUnpinContextMenuItem({
        pinnedCount: pinnedSelectedThreads.length,
      });
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(unpinMenuItem
              ? [{ ...unpinMenuItem, disabled: !canOperateThreads(pinnedSelectedThreads) }]
              : []),
            {
              id: "settle",
              label: `Settle (${count})`,
              disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
            },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    disabled: !canOperateThreads(selectedThreads),
                    children: [
                      ...snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `${preset.label} (${preset.whenLabel})`,
                        disabled: !canOperateThreads(selectedThreads),
                      })),
                      {
                        id: "snooze:custom",
                        label: "Custom…",
                        separatorBefore: true,
                        disabled: !canOperateThreads(selectedThreads),
                      },
                    ],
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem
              ? [
                  {
                    ...titleRegenerationMenuItem,
                    disabled:
                      titleRegenerationMenuItem.disabled ||
                      !canOperateThreads(regeneratableTitleThreads),
                  },
                ]
              : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            {
              id: "delete",
              label: `Delete (${count})`,
              destructive: true,
              disabled: !canOperateThreads(selectedThreads),
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const actionTargets =
        clicked.value === "unpin"
          ? pinnedSelectedThreads
          : clicked.value === "regenerate-title"
            ? regeneratableTitleThreads
            : clicked.value === "settle"
              ? settlingThreads.flatMap((thread) => {
                  const current = threadByKeyRef.current.get(
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                  );
                  return current && current.settledOverride !== "settled" ? [current] : [];
                })
              : selectedThreads;
      if (clicked.value === "settle" && actionTargets.length === 0) return;
      if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
      if (clicked.value?.startsWith("snooze:")) {
        const preset =
          clicked.value === "snooze:custom"
            ? await requestCustomSnooze()
            : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
        if (preset) {
          const coSnoozingKeys = new Set(threadKeys);
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  snoozedThreadRefs.length > 0
                    ? `Failed to snooze ${failures.length} thread${failures.length === 1 ? "" : "s"}`
                    : "Failed to snooze threads",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
        }
        return;
      }
      if (clicked.value === "unpin") {
        for (const thread of pinnedSelectedThreads) {
          attemptUnpin(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        settleThreads(
          actionTargets.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      if (
        !checkThreadOperations(
          threadKeys.flatMap((threadKey) => {
            const thread = threadByKeyRef.current.get(threadKey);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
  );

  const handleDraftContextMenu = useStableCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const projectGroup = projectGroupsRef.current.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === session.environmentId && ref.projectId === session.projectId,
          ),
        );
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              isQueued: queuedDraftIds.has(draftId),
              queueWritable: !useThreadQueueStore.getState().readOnly,
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: projectGroup != null,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "queue":
          case "unqueue":
            toggleDraftQueue(draftId, session);
            return;
          case "project-settings":
            if (projectGroup)
              openProjectSettings(projectGroup, {
                environmentId: session.environmentId,
                projectId: session.projectId,
              });
            return;
          case "copy-path":
            if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-branch":
            if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
            return;
          case "discard": {
            // The menu can stay open while the draft sends; discarding a
            // promoting draft would strand the send.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
  );

  const sectionCommands = useSidebarSectionCommands();
  const handleCustomSectionContextMenu = useStableCallback(
    (section: SidebarSectionView, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              { id: "rename" as const, label: "Rename section", icon: "pencil" },
              { id: "delete" as const, label: "Delete section", icon: "trash", destructive: true },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        await (clicked.value === "rename"
          ? sectionCommands.rename(section)
          : sectionCommands.remove(section));
      })();
    },
  );
  const handleThreadContextMenu = useStableCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
          null;
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const supportsPinning =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true;
        const supportsAutoSettleOptOut =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadAutoSettleOptOut === true;
        const supportsTitleRegeneration =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        const isPinned = thread.pinnedAt != null;
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
        const sidebarSectionsState = sidebarSectionMoveState({
          sections: sidebarSections,
          thread,
          supportsSections:
            serverConfigs.get(thread.environmentId)?.environment.capabilities
              .threadSidebarSections === true,
        });
        const threadProjectGroup =
          projectGroupsRef.current.find((project) =>
            project.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            ),
          ) ?? null;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildThreadActionMenuItems({
              canOperate: readEnvironmentScope(
                threadRef.environmentId,
                AuthOrchestrationOperateScope,
              ),
              branch: thread.branch ?? null,
              projectFilter: threadProjectGroup
                ? {
                    label: threadProjectGroup.displayName,
                    isActive: projectScopeKey === threadProjectGroup.projectKey,
                  }
                : null,
              isPinned,
              isSettled,
              autoSettleEnabled: thread.autoSettleDisabledAt == null,
              isSnoozed,
              ...readThreadQueueMenuState(thread),
              sidebarSections: sidebarSectionsState,
              canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
              isRegeneratingTitle,
              isRunning: !threadRuntimeCanArchive(thread.runtime),
              supports: {
                settlement: supportsSettlement,
                autoSettleOptOut: supportsAutoSettleOptOut,
                snooze: supportsSnooze,
                pinning: supportsPinning,
                titleRegeneration: supportsTitleRegeneration,
              },
              snoozePresets,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        const moveTarget = resolveSidebarSectionMoveAction(clicked.value, sidebarSections);
        if (moveTarget !== null) {
          await moveThreadToSidebarSection(threadRef, moveTarget.sectionId, moveTarget.sectionName);
          return;
        }
        switch (clicked.value) {
          case "filter-by-project":
            if (threadProjectGroup) {
              setProjectScopeKey(
                projectScopeKey === threadProjectGroup.projectKey
                  ? null
                  : threadProjectGroup.projectKey,
              );
            }
            return;
          case "project-settings":
            if (threadProjectGroup)
              openProjectSettings(threadProjectGroup, {
                environmentId: threadRef.environmentId,
                projectId: thread.projectId,
              });
            return;
          case "new-thread-on-branch": {
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "pin":
            attemptPin(threadRef);
            return;
          case "queue":
          case "unqueue":
            await runThreadQueueMenuAction(clicked.value, thread, async () =>
              attemptUnsnooze(threadRef),
            );
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "auto-settle:enabled":
          case "auto-settle:disabled": {
            const result = await setThreadAutoSettle(
              threadRef,
              clicked.value === "auto-settle:enabled",
            );
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to update auto-settle",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: didArchive
                    ? "Thread archived, but navigation failed"
                    : "Failed to archive thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
  );

  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeRowThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeRowThreadKey,
    routeTerminalOpen,
    threadByKey,
  ]);

  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  const handleNewThreadClick = (event?: ReactMouseEvent) => {
    if (shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projectGroups.length)) {
      if (isMobile) setOpenMobile(false);
      void startNewThreadFromContext({
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread ?? undefined,
        defaultProjectRef: newThreadContext.defaultProjectRef,
        handleNewThread: newThreadContext.handleNewThread,
      });
      return;
    }
    if (isMobile) setOpenMobile(false);
    openCommandPalette({ open: "new-thread-in" });
  };

  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  // The sidebar list's children and the drag overlay, built together in plain render code. The
  // overlay renders as the list's SIBLING - see the comment at the <ul>. It is position:fixed, so
  // where it mounts costs nothing visually, but mounting it inside role="list" adds a phantom
  // item for the length of a drag.
  const sidebarList = isSearchingThreads
    ? null
    : (() => {
        const overlayVerb =
          dragState === null
            ? null
            : resolveSidebarDropVerb(
                dragState.activeSection,
                dragTargetSection,
                dragState.fromQueue,
                isContextDrag ? null : dragState.overZone,
              );
        // The badge names the section the drop lands in (its target), not the one
        // under the pointer.
        const overlaySectionName =
          overlayVerb !== "move"
            ? null
            : dragTargetSection !== null && isCustomSidebarSection(dragTargetSection)
              ? (sidebarSections?.find(
                  (section) => customSidebarSection(section.id) === dragTargetSection,
                )?.name ?? null)
              : "Active";
        const snoozeOver = !isContextDrag && dragState?.overZone === "snooze";
        const threadRowVariant = (section: SidebarSection): "card" | "slim" =>
          section === "active" ||
          section === "pinned" ||
          section === "working" ||
          isCustomSidebarSection(section)
            ? "card"
            : "slim";
        // One prop set for every copy of a row: the sortable main-list row, a
        // Queue row (which brings its own sortable bag) and the drag overlay copy.
        const threadRowProps = (
          thread: EnvironmentThreadShell,
          section: SidebarSection,
          isOverlayCopy?: boolean,
          queueNote?: string | null,
        ): Omit<SidebarThreadRowProps, "sortable"> => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return {
            isOverlayCopy,
            thread,
            variant: threadRowVariant(section),
            queueNote,
            variantAction:
              section === "snoozed" ? "unsnooze" : section === "settled" ? "unsettle" : "settle",
            settlementSupported:
              serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
              true,
            snoozeSupported:
              serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze ===
              true,
            pinningSupported:
              serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning ===
              true,
            isPinned: thread.pinnedAt != null,
            dropVerb: dragState?.activeKey === threadKey ? overlayVerb : null,
            dropSectionName: dragState?.activeKey === threadKey ? overlaySectionName : null,
            dragOverPinned: dragState?.activeKey === threadKey && dragTargetSection === "pinned",
            sweepAction: actionSweep?.keys.has(threadKey) ? actionSweep.action : null,
            snoozeWakeLabelText:
              section === "snoozed" && thread.snoozedUntil != null
                ? snoozeWakeLabel(thread.snoozedUntil, {
                    now: new Date().toISOString(),
                  })
                : null,
            wokeAt: threadWokeAt(thread, { now: snoozeNow }),
            isActive: routeRowThreadKey === threadKey,
            isRouteThread: routeThreadKey === threadKey,
            openPullRequestsInRightPanel: routeThreadRef !== null,
            jumpLabel: showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null,
            currentEnvironmentId: primaryEnvironmentId,
            environmentLabel: environmentLabelById.get(thread.environmentId) ?? null,
            environmentMachine: environmentMachineById.get(thread.environmentId) ?? "server",
            scratchMachineLabel: scratchMachineLabelFor(thread),
            project: projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
            projectDisplayName:
              projectDisplayNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
            providerEntryByInstanceId:
              providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES,
            timestampFormat,
            onThreadClick: handleThreadClick,
            onThreadActivate: navigateToThread,
            onStartRename: startThreadRename,
            onRenameTitleChange: setRenamingTitle,
            onCommitRename: commitThreadRename,
            onCancelRename: cancelThreadRename,
            isRenaming: renamingThreadKey === threadKey,
            renamingTitle: renamingThreadKey === threadKey ? renamingTitle : "",
            onContextMenu: handleThreadContextMenu,
            onSettle: attemptSettle,
            onActionSweepStart: startActionSweep,
            onUnsettle: attemptUnsettle,
            onSnooze: attemptSnooze,
            onUnsnooze: attemptUnsnooze,
            onUnpin: attemptUnpin,
            onAcknowledgeWoke: acknowledgeWoke,
            onFileDropThreads: handleThreadFileDrop,
          };
        };
        // A Queue row or the overlay copy: the caller owns the sortable bag.
        const renderThreadRowInner = (
          thread: EnvironmentThreadShell,
          section: SidebarSection,
          sortable?: SortableThreadRowBag,
          isOverlayCopy?: boolean,
          queueNote?: string | null,
        ) => {
          const rowProps = threadRowProps(thread, section, isOverlayCopy, queueNote);
          return (
            <SidebarThreadRow
              // Keyed by variant so a card/slim switch remounts the row.
              key={`${scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}:${rowProps.variant}`}
              {...rowProps}
              sortable={sortable}
            />
          );
        };
        const renderThreadRow = (thread: EnvironmentThreadShell, section: SidebarSection) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <SortableThreadRow
              key={threadKey}
              sortableId={threadKey}
              contextDrag={isContextDrag}
              sortableDisabled={
                renamingThreadKey === threadKey ||
                !draggableThreadKeys.has(threadKey) ||
                optimisticDrop !== null
              }
              {...threadRowProps(thread, section)}
            />
          );
        };
        const from = isContextDrag ? null : (dragState?.activeSection ?? null);
        // The row the overlay copy draws, resolved from the drag's own key so a
        // queued row and a main-list row are handled the same way.
        const overlayThread = dragState === null ? undefined : threadByKey.get(dragState.activeKey);
        const overlayRow =
          overlayThread === undefined
            ? null
            : {
                thread: overlayThread,
                section:
                  dragState?.fromQueue === true
                    ? ("active" as SidebarSection)
                    : (dragState?.activeSection ?? ("active" as SidebarSection)),
              };
        const overlayQueuedEntry =
          dragState?.fromQueue === true
            ? queueEntries.find((entry) => threadQueueEntryKey(entry) === dragState.activeKey)
            : undefined;
        const overlayQueueNote =
          overlayQueuedEntry === undefined ? null : queuedOnAnotherDevice(overlayQueuedEntry);
        // A queued row with no thread behind it (a draft, or another device's entry)
        // needs its own overlay copy or the user would drag nothing at all.
        const overlayEntry =
          overlayRow !== null || dragState?.queuedDraft !== true ? undefined : overlayQueuedEntry;
        const overlayDraftId =
          overlayEntry?.draftId != null && overlayEntry.ownerId === queueDeviceId()
            ? overlayEntry.draftId
            : null;
        const overlayForeign =
          overlayEntry !== undefined && overlayDraftId === null && queueMode !== "local"
            ? overlayEntry
            : null;
        // A main-list drag: the Queue collapses to its docked header.
        const queueDropShown = from !== null && dragState?.fromQueue !== true;
        // A Queue row leaves no section behind, so emptiness hints ignore it.
        const leavingSection = dragState?.fromQueue ? null : from;
        const items: ReactNode[] = [
          <SidebarDraftBlock
            key="draft-sessions"
            projectByKey={projectByKey}
            projectDisplayNameByKey={projectDisplayNameByKey}
            scopedProjectKeys={scopedProjectKeys}
            routeDraftId={routeDraftIdForRows}
            onNavigateToDraft={navigateToDraft}
            queuedDraftIds={queuedDraftIds}
            onToggleDraftQueue={toggleDraftQueue}
            onDraftContextMenu={handleDraftContextMenu}
          />,
        ];
        // Queue sits between Active and the shelves below it.
        let queueRendered = false;
        const pushQueue = () => {
          if (queueRendered) return;
          queueRendered = true;
          items.push(
            <SidebarQueueBlock
              key="queue"
              entries={sidebarQueueBlockEntries(queuePlacement, shownQueueEntries)}
              isEntryActive={isQueueEntryActive}
              routeKey={routeThreadKey}
              routeDraftId={routeDraftIdForRows}
              expanded={queueExpanded}
              onToggleExpanded={toggleQueueExpanded}
              dragging={queueDropShown}
              collapse={queuePlacement.collapse}
              heldDrop={optimisticDrop}
              renderEntry={(
                entry: ThreadQueueEntry,
                bag: QueueRowSortableBag,
                note: string | null,
              ) => {
                const thread = threadByKey.get(threadQueueEntryKey(entry));
                if (thread !== undefined) {
                  return renderThreadRowInner(thread, "active", bag, undefined, note);
                }
                if (entry.draftId !== null && entry.ownerId === queueDeviceId()) {
                  return (
                    <QueuedDraftRow
                      draftId={entry.draftId}
                      projectByKey={projectByKey}
                      projectDisplayNameByKey={projectDisplayNameByKey}
                      isActive={entry.draftId === routeDraftIdForRows}
                      onNavigate={navigateToDraft}
                      onToggleQueue={toggleDraftQueue}
                      onContextMenu={handleDraftContextMenu}
                      sortable={bag}
                    />
                  );
                }
                // Local mode has no other device; a missing thread there is pruned.
                return queueMode === "local" ? null : (
                  <ForeignQueueRow entry={entry} sortable={bag} />
                );
              }}
            />,
          );
        };
        for (const item of sidebarListItems) {
          if (item.kind === "thread") {
            items.push(renderThreadRow(threadByKey.get(item.key)!, item.section));
            continue;
          }
          // An empty Queue docks with the shelves: inline above the custom sections its
          // drop zone would push them down at pickup. Placed after every row
          // (`belowShelves`), no marker renders it: the trailing call does.
          if (
            !queuePlacement.belowShelves &&
            ((item.marker === "custom-header" && !queuePlacement.docksWithShelves) ||
              item.marker === "working-header" ||
              item.marker === "snoozed-header" ||
              item.marker === "snoozed-placeholder" ||
              item.marker === "settled-header")
          ) {
            pushQueue();
          }
          switch (item.marker) {
            case "pinned-header":
              items.push(
                <SidebarDragBoundary
                  key="pinned-header"
                  marker="pinned-header"
                  label="Pinned"
                  visible={from !== null && !dragState?.fromQueue}
                  isDropTarget={dragTargetSection === "pinned"}
                />,
              );
              break;
            case "pinned-divider":
              items.push(
                <SidebarDragBoundary
                  key="pinned-divider"
                  marker="pinned-divider"
                  label="Active"
                  visible={from !== null && !dragState?.fromQueue}
                  isDropTarget={dragTargetSection === "active"}
                />,
              );
              break;
            case "active-placeholder":
              items.push(
                <SidebarSectionPlaceholder
                  key="active-placeholder"
                  marker="active-placeholder"
                  label="Active"
                  showHint={
                    from !== null &&
                    (activeThreads.length === 0 ||
                      (leavingSection === "active" &&
                        activeThreads.length === 1 &&
                        dragTargetSection !== null &&
                        dragTargetSection !== "active"))
                  }
                  isDropTarget={dragTargetSection === "active"}
                />,
              );
              break;
            case "custom-header": {
              const block = visibleCustomThreads.find(
                (candidate) => candidate.section.id === item.sectionId,
              );
              if (block === undefined) break;
              const expanded = !collapsedCustomSectionIds.includes(item.sectionId);
              items.push(
                <SidebarCustomSectionHeader
                  key={customSectionHeaderId(item.sectionId)}
                  sectionId={item.sectionId}
                  name={block.section.name}
                  count={sectionCounts.custom.get(item.sectionId) ?? "0/0"}
                  dragging={from !== null}
                  isDropTarget={dragTargetSection === customSidebarSection(item.sectionId)}
                  toggle={{
                    expanded,
                    onToggle: () => toggleCustomSection(item.sectionId),
                  }}
                  onContextMenu={
                    sectionCommands.canEdit
                      ? (position) => handleCustomSectionContextMenu(block.section, position)
                      : undefined
                  }
                />,
              );
              break;
            }
            case "working-header":
              items.push(
                <SidebarSectionHeader
                  key="working-shelf-header"
                  marker="working-header"
                  className="mt-auto"
                  label="Working"
                  count={sectionCounts.working}
                  toggle={{
                    expanded: workingShelfExpanded,
                    onToggle: toggleWorkingShelf,
                  }}
                />,
              );
              break;
            case "snoozed-header":
              items.push(
                <SidebarSectionHeader
                  key="snoozed-shelf-header"
                  marker="snoozed-header"
                  className={cn(workingThreads.length === 0 && "mt-auto")}
                  isDropTarget={snoozeOver}
                  label="Snoozed"
                  count={sectionCounts.snoozed}
                  toggle={{
                    expanded: snoozedShelfExpanded,
                    onToggle: toggleSnoozedShelf,
                  }}
                />,
              );
              break;
            case "snoozed-placeholder":
              items.push(
                <SidebarSnoozedPlaceholder
                  key="snoozed-placeholder"
                  firstShelf={workingThreads.length === 0}
                  // One decision for the paint, the zone and the preview.
                  showHint={from !== null && snoozeHint !== "closed"}
                  atEnd={snoozeHint === "at-end"}
                  isDropTarget={snoozeOver}
                />,
              );
              break;
            case "settled-header":
              items.push(
                <SidebarSectionHeader
                  key="settled-shelf-header"
                  marker="settled-header"
                  label="Settled"
                  count={sectionCounts.settled}
                  dragging={from !== null}
                  isDropTarget={dragTargetSection === "settled"}
                  toggle={{
                    expanded: settledShelfExpanded,
                    onToggle: toggleSettledShelf,
                  }}
                />,
              );
              break;
            case "settled-placeholder":
              items.push(
                <SidebarSectionPlaceholder
                  key="settled-placeholder"
                  marker="settled-placeholder"
                  label="Settled"
                  showHint={
                    from !== null &&
                    (renderedSettledThreads.length === 0 ||
                      (leavingSection === "settled" &&
                        renderedSettledThreads.length === 1 &&
                        dragTargetSection !== null &&
                        dragTargetSection !== "settled"))
                  }
                  isDropTarget={dragTargetSection === "settled"}
                />,
              );
              break;
          }
        }
        pushQueue();
        // The dragged row travels as an overlay copy. dnd-kit only hands a row its
        // own pointer offset while `over` is a sibling in that row's SortableContext,
        // and the sidebar has two of them plus plain droppables, so the source itself
        // cannot follow the pointer across a crossing. With an overlay mounted dnd-kit
        // stops displacing the source and drives the copy instead, which is the only
        // path that carries the scroll delta as well as the pointer delta.
        // The row the overlay carries is an <li>, so our wrapper is the <ul> that
        // gives it a legal list parent. dnd-kit's own wrapper stays a plain div,
        // which is fine now that the overlay sits outside the sidebar's list.
        // Built here rather than through renderThreadRowInner: that helper is also handed to the
        // Queue as a render prop, and calling it during render makes the React Compiler treat it as
        // a ref access. Its key is built from the section, not read back off the props object (whose
        // handlers read refs), for the same reason.
        const overlayRowNode =
          overlayRow === null ? null : (
            <SidebarThreadRow
              // Keyed by variant like every other copy of a row, so a card/slim switch remounts it.
              key={`${scopedThreadKey(scopeThreadRef(overlayRow.thread.environmentId, overlayRow.thread.id))}:${threadRowVariant(overlayRow.section)}`}
              {...threadRowProps(overlayRow.thread, overlayRow.section, true, overlayQueueNote)}
              sortable={overlaySortableBag}
            />
          );
        const dragOverlayNode = (
          <DragOverlay dropAnimation={null}>
            {overlayRow === null && overlayDraftId === null && overlayForeign === null ? null : (
              <ul className="list-none" data-testid="sidebar-drag-overlay" aria-hidden inert>
                {overlayRow !== null ? (
                  overlayRowNode
                ) : overlayForeign !== null ? (
                  <ForeignQueueRow
                    entry={overlayForeign}
                    sortable={overlaySortableBag}
                    isOverlayCopy
                  />
                ) : (
                  <QueuedDraftRow
                    draftId={overlayDraftId!}
                    projectByKey={projectByKey}
                    projectDisplayNameByKey={projectDisplayNameByKey}
                    isActive={overlayDraftId === routeDraftIdForRows}
                    onNavigate={navigateToDraft}
                    onToggleQueue={toggleDraftQueue}
                    onContextMenu={handleDraftContextMenu}
                    sortable={overlaySortableBag}
                    isOverlayCopy
                  />
                )}
              </ul>
            )}
          </DragOverlay>
        );
        return { items, dragOverlayNode };
      })();
  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarThreadHeader
              searchFieldRef={headerSearchRef}
              hasProjects={projectGroups.length > 0}
              projectScope={
                <Combobox
                  items={projectScopeItems}
                  filteredItems={filteredProjectScopeItems}
                  autoHighlight
                  itemToStringLabel={(item) => item.label}
                  isItemEqualToValue={(a, b) => a.value === b.value}
                  open={projectScopeMenuState.open}
                  onOpenChange={(open) => {
                    if (open) suppressNextScopeChangeRef.current = false;
                    dispatchProjectScopeMenu({ type: "open-changed", open });
                  }}
                  onItemHighlighted={(item) => {
                    highlightedProjectScopeKeyRef.current = item?.value ?? null;
                  }}
                  value={selectedProjectScopeItem}
                  onValueChange={(item) => {
                    if (suppressNextScopeChangeRef.current) {
                      suppressNextScopeChangeRef.current = false;
                      return;
                    }
                    if (!item) return;
                    setProjectScopeKey(item.value === "all" ? null : item.value);
                  }}
                >
                  <ComboboxTrigger
                    render={
                      <SidebarHeaderIconButton
                        label={
                          scopedProjectGroup
                            ? `Filter threads by project: ${scopedProjectGroup.displayName}`
                            : "Filter threads by project"
                        }
                      />
                    }
                  >
                    {scopedProjectGroup ? (
                      <span className="flex shrink-0">
                        <ProjectFavicon project={scopedProjectGroup} className="size-4" />
                      </span>
                    ) : (
                      <ListFilterIcon className="size-4" />
                    )}
                  </ComboboxTrigger>
                  <ComboboxPopup
                    align="start"
                    anchor={headerSearchRef}
                    className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
                  >
                    <ComboboxSearchInput
                      aria-label="Search projects"
                      placeholder="Search projects..."
                      value={projectScopeMenuState.query}
                      onKeyDown={(event) => {
                        if (
                          event.defaultPrevented ||
                          event.nativeEvent.isComposing ||
                          event.ctrlKey ||
                          event.altKey ||
                          event.metaKey ||
                          (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                        ) {
                          return;
                        }
                        const scopeKey = highlightedProjectScopeKeyRef.current;
                        const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
                        if (project) handleProjectSettings(event, project);
                      }}
                      onChange={(event) =>
                        dispatchProjectScopeMenu({
                          type: "query-changed",
                          query: event.target.value,
                        })
                      }
                    />
                    <ComboboxEmpty>No matching projects.</ComboboxEmpty>
                    <ComboboxList>
                      {(item: (typeof projectScopeItems)[number]) => {
                        const project = projectGroupByScopeKey.get(item.value) ?? null;
                        return (
                          <ComboboxItem
                            key={item.value}
                            hideIndicator
                            value={item}
                            onContextMenu={(event) => {
                              if (project) handleProjectSettings(event, project);
                            }}
                          >
                            {project ? (
                              <ProjectFavicon project={project} className="size-4 shrink-0" />
                            ) : (
                              <FolderIcon className="size-4 shrink-0" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                            {project && showProjectEnvironments ? (
                              <ProjectEnvironmentBadge
                                group={project}
                                primaryEnvironmentId={primaryEnvironmentId}
                                machineByEnvironmentId={environmentMachineById}
                              />
                            ) : null}
                            {project ? (
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                tabIndex={-1}
                                aria-hidden="true"
                                title={`Project settings for ${project.displayName}`}
                                className="ml-auto"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  void handleProjectSettings(event, project);
                                }}
                              >
                                <SettingsIcon className="size-3.5" />
                              </Button>
                            ) : null}
                          </ComboboxItem>
                        );
                      }}
                    </ComboboxList>
                  </ComboboxPopup>
                </Combobox>
              }
              onNewProject={openAddProjectCommandPalette}
              onNewThread={handleNewThreadClick}
              {...(sidebarSections !== null && sectionCommands.canEdit
                ? { onNewSection: () => void sectionCommands.create() }
                : {})}
              newThreadDisabled={projects.length === 0}
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={projectGroups.length > 1}
              searchInputRef={threadSearchInputRef}
              searchQuery={threadSearchQuery}
              onSearchQueryChange={(value) => {
                setThreadSearchQuery(value);
                setActiveSearchResultIndex(0);
              }}
              onSearchKeyDown={handleThreadSearchKeyDown}
              isSearching={isSearchingThreads}
              searchResultCount={threadSearchResults.length}
              activeSearchResultIndex={activeSearchResultIndex}
              onClearSearch={clearThreadSearch}
            />
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarSearchResultRow
                        isSettled={settledThreadKeys.has(threadKey)}
                        key={threadKey}
                        thread={thread}
                        project={
                          projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectDisplayName={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeRowThreadKey === threadKey}
                        resultId={`sidebar-thread-search-result-${index}`}
                        searchMatch={
                          threadSearchMatchByKey.get(
                            threadSearchMatchKey({
                              environmentId: thread.environmentId,
                              threadId: thread.id,
                            }),
                          ) ?? null
                        }
                        searchQuery={threadSearchQuery}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
              </p>
            )
          ) : null}
          {!isSearchingThreads ? (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <DndContext
                sensors={dndSensors}
                autoScroll={!isContextDrag}
                collisionDetection={dndCollisionDetection}
                modifiers={dndModifiers}
                onDragStart={handleThreadDragStart}
                onDragOver={handleThreadDragOver}
                onDragEnd={handleThreadDragEnd}
              >
                <SidebarDragLifecycle onUnmount={cancelThreadDrag} />
                <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
                  {/* The drag overlay is position:fixed and must NOT live inside the list: as a
                      child of role="list" its wrapper is announced as an extra empty item for the
                      length of every drag. It is built with the list's children (`sidebarList`,
                      above the return) and rendered below as the list's sibling. */}
                  <ul
                    ref={attachListMotionRef}
                    // VoiceOver treats an exposed list as an interaction boundary,
                    // which hides its rows from ordinary linear navigation. A
                    // presentational list also makes its implicit listitems
                    // presentational while preserving every descendant control.
                    role="presentation"
                    className={cn(
                      "relative flex flex-col gap-px",
                      sidebarListItems.length > 0 && "flex-1",
                      actionSweep !== null && "**:pointer-events-none",
                    )}
                  >
                    {sidebarList?.items}
                    {settledShelfExpanded && hiddenSettledCount > 0 ? (
                      <SidebarSettledShowMore
                        count={Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)}
                        onClick={showMoreSettled}
                      />
                    ) : null}
                  </ul>
                  {sidebarList?.dragOverlayNode}
                </SortableContext>
              </DndContext>
            </TooltipProvider>
          ) : null}
          {!isSearchingThreads &&
          visibleDraftSessionCount === 0 &&
          queueEntries.length === 0 &&
          countSidebarThreads({
            lists: [pinnedThreads, activeThreads, workingThreads, snoozedThreads, settledThreads],
            customThreads,
          }) === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroup ? (
                `No threads in ${scopedProjectGroup.displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

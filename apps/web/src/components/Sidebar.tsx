import { type EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { ThreadHoverCard, ThreadHoverCardPopup } from "./ThreadHoverCard";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import { ThreadTerminalStatusButton } from "./ThreadStatusIndicators";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "./chat/threadContextDrag";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
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
import { CSS } from "@dnd-kit/utilities";
import {
  canSnooze,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  resolveSettledThreadTimestamp,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import {
  resolveThreadProviderStack,
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
  type EnvironmentMachineKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  EllipsisIcon,
  FolderIcon,
  GitBranchIcon,
  ListFilterIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SettingsIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  XIcon,
  ListPlusIcon,
  ListXIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";

import { useRightPanelStore } from "../rightPanelStore";
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
import { useOpenPrLink } from "../lib/openPullRequestLink";
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
import { useNowSecond } from "../hooks/useNowSecond";
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
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  resolveSidebarSectionMoveAction,
  threadActionRequiresOperate,
} from "./threadActionMenu.logic";
import {
  animateSidebarLayoutChanges,
  applySidebarThreadDrop,
  sidebarListedThreads,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  formatWorkingDurationLabel,
  firstValidTimestampMs,
  hasUnseenCompletion,
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
  resolveSidebarRowAccessibility,
  type SidebarDropVerb,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  isSidebarThreadWoke,
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
  shouldRecedeSidebarThread,
  resolveWorkingStartedAt,
  sidebarListItemId,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useThreadJumpHintVisibility,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
  type SidebarListItem,
  type SidebarSection,
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
  QUEUED_ON_ANOTHER_DEVICE_SHORT,
  queuedOnAnotherDevice,
  type QueueRowSortableBag,
} from "./SidebarQueueBlock";
import { threadQueueEntryKey, type ThreadQueueEntry } from "../threadQueueRules";
import { queueDeviceId, useThreadQueueStore } from "../threadQueueStore";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
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
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  ThreadWorktreeIndicator,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "./ThreadStatusIndicators";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ThreadProviderChip, ThreadProviderRail } from "./ThreadProviderRail";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useStableCallback } from "../hooks/useStableCallback";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button, InlineButton } from "./ui/button";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "./ui/menu";
import { SidebarThreadSubagentIndicator } from "./sidebar/SidebarThreadSubagentIndicator";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  useThreadHasUnsentDraft,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;

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
const NOT_STARTED_EXPANDED_KEY = "t3code:sidebar:not-started-expanded";
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
  readonly routeThreadKey: string | null;
  readonly queueEntries: readonly ThreadQueueEntry[];
  readonly sidebarSections: readonly SidebarSectionView[] | null;
  readonly queueExpanded: boolean;
}) {
  const {
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    routeThreadKey,
    queueEntries,
    sidebarSections,
    queueExpanded,
  } = input;
  // A held join renders in its section, not in the Queue.
  const shownQueueEntries = sidebarShownQueueEntries(queueEntries, optimisticDrop);
  const shownQueuedKeys = new Set(shownQueueEntries.map(threadQueueEntryKey));
  const customSectionIds = new Set((sidebarSections ?? []).map((section) => section.id));
  const threads = useThreadShells();
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
    if (routeThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find((thread) => threadShellKey(thread) === routeThreadKey);
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  })();
  const renderedSettledThreads = settledShelfExpanded
    ? visibleSettledThreads
    : routeThreadOnly(visibleSettledThreads, routeThreadKey);
  const visibleSnoozedThreads = snoozedShelfExpanded
    ? snoozedThreads
    : routeThreadOnly(snoozedThreads, routeThreadKey);
  // Collapsed, only the open queued thread keeps its row, as on the snoozed shelf.
  const visibleQueuedThreads = queueExpanded
    ? queuedThreads
    : queuedThreads.filter((thread) => threadShellKey(thread) === routeThreadKey);
  const visibleWorkingThreads = workingShelfExpanded
    ? workingThreads
    : routeThreadOnly(workingThreads, routeThreadKey);
  // Collapsed, a custom section keeps only the open thread's row, as the shelves do.
  const visibleCustomThreads =
    sidebarSections === null || sidebarSections.length === 0
      ? NO_CUSTOM_BLOCKS
      : sidebarSections.map((section) => {
          const rows = customThreads.get(section.id) ?? EMPTY_THREADS;
          return {
            section,
            visible: collapsedCustomSectionIds.includes(section.id)
              ? rows.filter((thread) => threadShellKey(thread) === routeThreadKey)
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

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

// Subscribes to the minute tick itself, so only the label re-renders each
// minute. The minute is passed as the clock so it is the formatter's input.
function RelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  return props.timestamp === null
    ? null
    : compactSidebarTimeLabel(
        formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`)),
      );
}

function threadTimeTimestamp(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}

function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel startedMs={startedMs} />;
}

// Self-ticking so only this span re-renders each second, not the whole row;
// the shared tick lands every working row's update in the same frame.
function WorkingDurationLabel(props: { startedMs: number }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">{formatWorkingDurationLabel(nowMs - props.startedMs)}</span>
  );
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
}) {
  const stack = resolveThreadProviderStack(props.thread);
  const currentInstanceId = stack[stack.length - 1]!;
  const currentEntry = props.providerEntryByInstanceId.get(currentInstanceId) ?? null;
  if (currentEntry === null) return null;
  const showInstanceBadge = shouldShowInstanceBadge(
    currentEntry,
    props.providerEntryByInstanceId.values(),
  );
  const current = (
    <ProviderInstanceIcon
      driverKind={currentEntry.driverKind}
      displayName={currentEntry.displayName}
      accentColor={currentEntry.accentColor}
      acpRegistryAgentId={currentEntry.acpRegistryAgentId}
      acpRegistryIconUrl={currentEntry.acpRegistryIconUrl}
      showBadge={showInstanceBadge}
      iconClassName="size-3.5 opacity-60"
      badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs"
    />
  );
  if (stack.length === 1) {
    return <span className="inline-flex shrink-0 items-center">{current}</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {stack.slice(0, -1).map((instanceId) => {
        const entry = props.providerEntryByInstanceId.get(instanceId);
        if (entry === undefined) return null;
        return (
          <ProviderInstanceIcon
            key={instanceId}
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
            iconClassName="size-3 opacity-35 grayscale"
          />
        );
      })}
      <span className="relative z-10 inline-flex items-center">{current}</span>
    </span>
  );
}

function SidebarThreadTooltip({
  thread,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: SidebarProviderEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard
        title={thread.title}
        footer={
          supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
            </div>
          ) : null
        }
      >
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              kind={environmentMachine}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        {thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word leading-5">
              You're currently checked out on another branch.
            </div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerEntry?.accentColor}
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
              showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
              badgeContent="none"
              badgeClassName="h-2 min-w-2 px-0"
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {showInstanceBadge && providerEntry
                ? `${modelLabel} · ${providerEntry.displayName}`
                : modelLabel}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              Handed off from {previousProviderNames.join(", ")}
            </div>
          </div>
        ) : null}
        {terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount)}
            </div>
          </div>
        ) : null}
        {thread.runtime?.lastError ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              thread.runtime.lastErrorClass === "usage_limit" ? "text-warning" : "text-error",
            )}
          >
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">
              {thread.runtime.lastErrorClass === "usage_limit"
                ? "Usage limit reached"
                : "Error occurred"}
            </div>
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat } = props;
  const presets = open ? resolveSnoozePresets(new Date(), timestampFormat) : [];
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Snooze thread"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Snooze thread</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              onSnooze(preset);
            }}
          >
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

// useSortable memoizes on its `disabled` object, so a fresh one per render
// re-renders every row and marker on each sidebar update.
const SIDEBAR_SORTABLE_DRAG_DISABLED = { draggable: true } as const;
const SIDEBAR_SORTABLE_DRAG_ENABLED = { draggable: false } as const;

// Takes the row's props rather than a render function: a closure from the
// sidebar body is new on every sidebar render, which rebuilt the bag and
// re-rendered every memoized row with it.
function SortableThreadRow(
  props: Omit<SidebarThreadRowProps, "sortable"> & {
    sortableId: string;
    sortableDisabled: boolean;
    contextDrag: boolean;
  },
) {
  const { sortableId, sortableDisabled, contextDrag, ...rowProps } = props;
  const canOperateThread = useEnvironmentScope(
    rowProps.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled:
      sortableDisabled || !canOperateThread
        ? SIDEBAR_SORTABLE_DRAG_DISABLED
        : SIDEBAR_SORTABLE_DRAG_ENABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit memoizes each field but not the bag, so the memoized row would
  // rerender on every shell update without this.
  const bag = {
    listeners,
    setNodeRef,
    transform: contextDrag ? null : transform,
    transition: contextDrag && isDragging ? "transform 150ms ease-out" : transition,
    isDragging: isDragging && !contextDrag,
  };
  // Keyed by variant so a card/slim switch remounts the row.
  return <SidebarThreadRow key={rowProps.variant} {...rowProps} sortable={bag} />;
}

const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

function SortableSidebarMarker(props: {
  item: Extract<SidebarListItem, { kind: "marker" }>;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarListItemId(props.item),
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      // Several custom headers share a test id; this tells them apart.
      data-section-id={props.item.marker === "custom-header" ? props.item.sectionId : undefined}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.item.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      item={{ kind: "marker", marker: props.marker }}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
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

type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";

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

function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      item={{ kind: "marker", marker: props.marker }}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  count: string;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const shelf =
    props.marker === "working-header"
      ? "working"
      : props.marker === "snoozed-header"
        ? "snoozed"
        : "settled";
  const snoozed = shelf === "snoozed";
  return (
    <SortableSidebarMarker
      item={{ kind: "marker", marker: props.marker }}
      data-testid={`sidebar-${props.marker}`}
      className={cn("mx-0.5 h-8", props.className)}
    >
      <CollapsibleSectionHeader
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={
          props.isDropTarget ? "accent" : props.dragging ? "emphasized" : snoozed ? "info" : "muted"
        }
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        count={props.count}
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
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

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  /** In the sidebar Queue: the row offers removal instead of adding. */
  queued: boolean;
  onToggleQueue: (draftId: DraftId, session: DraftSessionState) => void;
  sortable?: QueueRowSortableBag;
  /** See SidebarThreadRow: the drag presentation belongs to the copy, not the row left behind. */
  isOverlayCopy?: boolean | undefined;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const {
    composer,
    draftId,
    onContextMenu,
    onDiscard,
    onNavigate,
    onToggleQueue,
    session,
    sortable,
  } = props;
  const promptPreview =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: "Unsent draft",
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleActivate = () => onNavigate(draftId);
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    // Keys targeting the nested discard button belong to the button:
    // preventDefault here would swallow Space's synthesized click and
    // navigate instead of discarding.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onContextMenu(draftId, { x: rect.left, y: rect.bottom });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(draftId);
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(draftId, { x: event.clientX, y: event.clientY });
  };
  const handleDiscard = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onDiscard(draftId);
  };
  const handleToggleQueue = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleQueue(draftId, session);
  };
  const queueReadOnly = useThreadQueueStore((state) => state.readOnly);
  return (
    <li
      className={cn(
        "list-none py-0.5",
        // The draft's own surface is a 4%-opacity tint, so the carried copy needs a solid sidebar
        // backdrop beneath it or the page shows through while it floats.
        props.isOverlayCopy === true && "relative z-20 rounded-md bg-sidebar shadow-lg",
      )}
      ref={sortable?.setNodeRef}
      style={
        sortable
          ? {
              transform: CSS.Translate.toString(sortable.transform),
              transition: sortable.transition,
            }
          : undefined
      }
      {...sortable?.listeners}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : draftSurfaceClassName,
          // The row the pointer left behind: still in place, visibly not the one being carried.
          sortable?.isDragging === true && props.isOverlayCopy !== true && "opacity-40",
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{preview}</span>
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon aria-hidden className={draftPenClassName} />
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {props.projectDisplayName}
            </span>
            <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={props.queued ? "Remove from queue" : "Add to queue"}
                      disabled={queueReadOnly}
                      onClick={handleToggleQueue}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100 disabled:cursor-default disabled:hover:text-muted-foreground"
                    >
                      {props.queued ? (
                        <ListXIcon className="size-3" />
                      ) : (
                        <ListPlusIcon className="size-3" />
                      )}
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  {props.queued ? "Remove from queue" : "Add to queue"}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Discard draft"
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Discard draft</TooltipPopup>
              </Tooltip>
            </span>
          </div>
          <div aria-hidden className="mt-0.5 truncate text-sm font-medium text-foreground/90">
            {preview}
          </div>
        </div>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
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

const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  scopedProjectKeys: ReadonlySet<string> | null;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
  queuedDraftIds: ReadonlySet<string>;
  onToggleDraftQueue: (draftId: DraftId, session: DraftSessionState) => void;
  onDraftContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const session = draftThreadsByThreadKey[draftId];
      const composer = draftsByThreadKey[draftId];
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = (() => {
    const rows: SidebarDraftRowData[] = [];
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      // Queued drafts render under Queue instead.
      if (props.queuedDraftIds.has(draftKey)) {
        continue;
      }
      if (
        props.scopedProjectKeys !== null &&
        !props.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      if (draftKey === props.routeDraftId) {
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push(frozenActive.row);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  })();
  // Expanded by default so no draft hides until the user folds the section away. Collapsed, the
  // open draft keeps its row, the same exception the snoozed shelf makes for the open thread.
  const [expanded, setExpanded] = useLocalStorage(NOT_STARTED_EXPANDED_KEY, true, Schema.Boolean);
  const toggleExpanded = () => setExpanded((value) => !value);
  if (drafts.length === 0) {
    return null;
  }
  const visibleDrafts = expanded
    ? drafts
    : drafts.filter((draft) => draft.draftId === props.routeDraftId);
  return (
    <>
      <li className="mx-0.5 h-8 list-none" data-testid="sidebar-not-started-header">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          data-testid="sidebar-not-started-toggle"
          className="flex h-full w-full cursor-pointer items-center gap-2 px-2 text-left text-xs font-medium text-sidebar-muted-foreground/60"
        >
          <span className="shrink-0">
            {/* Drafts have no status, so they count idle, as in the Queue. */}
            {`Not started (0/${drafts.length})`}
          </span>
          <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
          />
        </button>
      </li>
      {visibleDrafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            session={session}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            onNavigate={props.onNavigateToDraft}
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
            queued={false}
            onToggleQueue={props.onToggleDraftQueue}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

const dropVerbBadge: Record<Exclude<SidebarDropVerb, "move">, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pin
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      Unpin
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      Settle
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      Un-settle
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      Wake
    </>
  ),
  unqueue: (
    <>
      <ListXIcon aria-hidden className="size-3" />
      Unqueue
    </>
  ),
  snooze: (
    <>
      <AlarmClockIcon aria-hidden className="size-3" />
      Snooze 1h
    </>
  ),
  "wake-queue": (
    <>
      <ListPlusIcon aria-hidden className="size-3" />
      {"Wake & queue"}
    </>
  ),
};

type SidebarThreadRowProps = {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  pinningSupported: boolean;
  isPinned: boolean;
  sortable?: SortableThreadRowBag | undefined;
  /**
   * True on the copy the DragOverlay carries. The drag presentation - the lifted card, the drop
   * verb, the raised stacking - belongs to whatever the pointer is holding; the row left behind in
   * the list recedes instead, so the two are never mistaken for each other.
   */
  isOverlayCopy?: boolean | undefined;
  dropVerb: SidebarDropVerb | null;
  /** The destination's name while `dropVerb` is "move". */
  dropSectionName: string | null;
  dragOverPinned: boolean;
  sweepAction: SidebarSweepAction | null;
  snoozeWakeLabelText: string | null;
  // A Queue row's note ("Queued on another device"): shown short after the branch, which it
  // would otherwise never fit beside, and in full as its tooltip.
  queueNote?: string | null | undefined;
  wokeAt: string | null;
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  scratchMachineLabel: string | null;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
};

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onFileDropThreads,
    onRenameTitleChange,
    onSettle,
    onActionSweepStart,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onUnpin,
    openPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  useEffect(() => {
    if (!canOperateThread && isRenaming) onCancelRename();
  }, [canOperateThread, isRenaming, onCancelRename]);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const terminalProcessCount = runningTerminalIds.length;
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isActive;
  const handleDiscardDraftClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    discardComposerDraft(threadRef);
  };

  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;

  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const isInFlight =
    status === "working" || status === "waiting" || status === "approval" || status === "input";
  const isWoke = isSidebarThreadWoke({
    lastVisitedAt,
    wokeAt: props.wokeAt,
    settledOverride: thread.settledOverride,
  });
  const shouldRecede = shouldRecedeSidebarThread({
    status,
    isUnread,
    isWoke,
    isActive: props.isActive,
    isSelected,
  });
  const topStatus =
    status === "working"
      ? {
          label: thread.goal?.status === "active" ? "Goal" : "Working",
          icon: "working" as const,
          className: "text-info",
        }
      : status === "waiting"
        ? {
            label: "Waiting",
            icon: "waiting" as const,
            className: "text-muted-foreground",
          }
        : status === "approval"
          ? {
              label: "Approval",
              icon: "approval" as const,
              className: "text-warning-foreground",
            }
          : status === "input"
            ? {
                label: "Input",
                icon: "input" as const,
                className: "text-indigo-600 dark:text-indigo-300",
              }
            : status === "limited"
              ? {
                  label: "Limited",
                  icon: "failed" as const,
                  className: "text-warning",
                }
              : status === "failed"
                ? {
                    label: "Failed",
                    icon: "failed" as const,
                    className: "text-error",
                  }
                : isWoke
                  ? {
                      label: "Woke",
                      icon: "woke" as const,
                      className: "text-warning",
                    }
                  : isUnread
                    ? {
                        label: "Done",
                        icon: "done" as const,
                        className: "text-success",
                      }
                    : null;
  const isWokeStatus = topStatus?.icon === "woke";

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const isRemote = thread.environmentId !== props.currentEnvironmentId;
  const showsScratchMachine = !thread.branch && props.scratchMachineLabel !== null;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={thread}
      project={props.project}
      projectDisplayName={props.projectDisplayName}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      providerEntry={providerEntry}
      providerEntryByInstanceId={props.providerEntryByInstanceId}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
    />
  );

  const handleClick = (event: ReactMouseEvent) => {
    onThreadClick(event, threadRef);
  };
  const handleAcknowledgeWokeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.wokeAt === null) return;
    onAcknowledgeWoke(threadRef, props.wokeAt);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onThreadActivate(threadRef);
  };
  const handleDoubleClick = (event: ReactMouseEvent) => {
    if (
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
      isRenaming ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    event.preventDefault();
    onStartRename(threadRef, thread.title);
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = onFileDropThreads
    ? makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      })
    : null;
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      renameCommittedRef.current = true;
      onCommitRename(threadRef, renamingTitle, thread.title);
    } else if (event.key === "Escape") {
      event.preventDefault();
      renameCommittedRef.current = true;
      onCancelRename();
    }
  };
  const handleRenameBlur = () => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  };
  const handleSettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSettle(threadRef);
  };
  const handleActionPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    onActionSweepStart(threadRef, variantAction, event.nativeEvent);
  };
  const handleUnsettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsettle(threadRef);
  };
  const handleUnsnoozeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsnooze(threadRef);
  };
  const handleUnpinClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnpin(threadRef);
  };
  const handleSnoozePreset = (preset: Pick<SnoozePreset, "snoozedUntil">) => {
    onSnooze(threadRef, preset);
  };
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // The React Compiler caches render results on their inputs, so a clock read
  // here would stay frozen until `thread` changes and a queued-turn gate would
  // never reopen. The gate's clock is state, reset with the thread.
  const [snoozeGateClock, setSnoozeGateClock] = useState(() => ({
    thread,
    now: new Date().toISOString(),
  }));
  if (snoozeGateClock.thread !== thread) {
    setSnoozeGateClock({ thread, now: new Date().toISOString() });
  }
  const snoozeGateNow = snoozeGateClock.now;
  const snoozeGateExpiryMs = hasQueuedTurnStart(thread, { now: snoozeGateNow })
    ? Date.parse(thread.latestUserMessageAt ?? "") + QUEUED_TURN_START_GRACE_MS
    : Number.NaN;
  useEffect(() => {
    // A gate still closed past its expiry is held by runtime status, not time,
    // so no clock tick can open it.
    if (!Number.isFinite(snoozeGateExpiryMs) || snoozeGateExpiryMs <= Date.parse(snoozeGateNow)) {
      return;
    }
    const id = window.setTimeout(
      () => setSnoozeGateClock({ thread, now: new Date().toISOString() }),
      Math.min(Math.max(0, snoozeGateExpiryMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [snoozeGateExpiryMs, snoozeGateNow, thread]);
  const showSnoozeButton =
    canOperateThread && props.snoozeSupported && canSnooze(thread, { now: snoozeGateNow });
  // Closing here, not just masking, keeps the menu from reopening when the button returns.
  if (snoozeMenuOpenRaw && !showSnoozeButton) setSnoozeMenuOpen(false);
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  const handlePrClick = (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
    const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const showInRightPanel = targetUrl !== undefined || openPullRequestsInRightPanel;
    const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
    if (openedInRightPanel && showInRightPanel && !props.isActive) {
      onThreadActivate(threadRef);
    }
  };

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    variantAction === "unsettle" && "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground"
        : hasUnsentDraft
          ? cn(draftSurfaceClassName, "text-sidebar-foreground")
          : shouldRecede
            ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
    props.isOverlayCopy === true &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
    // The row the pointer left behind: still in place, visibly not the one being carried.
    props.sortable?.isDragging === true && props.isOverlayCopy !== true && "opacity-40",
  );
  const sortable = props.sortable;
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // A zero-height boundary also makes dnd-kit scale the source to
          // zero. Only projected peers use scaleY as a visibility sentinel.
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : {};
  // The drop badge rides on the carried copy, not the row left behind.
  const destinationVerb =
    props.isOverlayCopy === true
      ? props.dropVerb
      : props.sweepAction === "unsnooze"
        ? "wake"
        : props.sweepAction;
  const dragDestination =
    destinationVerb !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
      >
        {destinationVerb === "move" ? (
          <>
            <FolderIcon aria-hidden className="size-3" />
            <span className="truncate">Move to {props.dropSectionName}</span>
          </>
        ) : (
          dropVerbBadge[destinationVerb]
        )}
      </span>
    ) : null;

  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: topStatus?.label ?? null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });

  const title =
    isRenaming && canOperateThread ? (
      <input
        autoFocus
        value={renamingTitle}
        aria-label="Thread title"
        onChange={(event) => onRenameTitleChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={handleRenameKeyDown}
        onBlur={handleRenameBlur}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
          shouldRecede ? "font-normal" : "font-medium",
          variant === "card"
            ? cn(
                "truncate",
                shouldRecede
                  ? "text-secondary-label"
                  : isUnread || isWoke || status === "input"
                    ? "text-foreground"
                    : status === "failed"
                      ? "text-foreground/95"
                      : "text-foreground/90",
              )
            : cn(
                "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                shouldRecede
                  ? "text-secondary-label/70"
                  : props.isActive || isWoke || status === "input"
                    ? "text-foreground"
                    : isUnread
                      ? "text-muted-foreground"
                      : "text-secondary-label/70",
              ),
          isRegeneratingTitle && "opacity-55",
        )}
      >
        {thread.title}
      </span>
    );
  const accessibleTitle = isRenaming ? null : <span className="sr-only">{thread.title}</span>;

  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const handlePrListClick = () => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isActive) onThreadActivate(threadRef);
  };
  const prBadge =
    prBadgeShape?.kind === "stack" || pr || currentLinkedPr ? (
      <ThreadPullRequestBadgeControl
        render={<InlineButton />}
        badge={prBadgeShape}
        pullRequests={thread.pullRequests}
        number={pr?.number ?? currentLinkedPr?.number}
        url={pr?.url ?? currentLinkedPr?.url}
        status={prStatus}
        onOpenList={handlePrListClick}
        onOpenPullRequest={handlePrClick}
      />
    ) : null;
  const terminalStatusIcon = (
    <ThreadTerminalStatusButton
      threadRef={threadRef}
      terminalIds={runningTerminalIds}
      onThreadActivate={onThreadActivate}
    />
  );
  const subagentIndicator = (
    <SidebarThreadSubagentIndicator environmentId={thread.environmentId} threadId={thread.id} />
  );
  const draftIndicator = hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Unsent draft"
            data-testid={`sidebar-draft-indicator-${thread.id}`}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        <SquarePenIcon aria-hidden className={draftPenClassName} />
      </TooltipTrigger>
      <TooltipPopup side="top">Unsent draft</TooltipPopup>
    </Tooltip>
  ) : null;
  const showPin =
    props.isPinned && (!sortable?.isDragging || (props.dragOverPinned && props.dropVerb === null));
  const pinIndicator = showPin ? (
    props.pinningSupported && canOperateThread && !sortable?.isDragging ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Unpin thread"
              onClick={handleUnpinClick}
              className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <PinIcon
            aria-hidden
            className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
          />
          <PinOffIcon
            aria-hidden
            className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
          />
        </TooltipTrigger>
        <TooltipPopup>Unpin thread</TooltipPopup>
      </Tooltip>
    ) : (
      <PinIcon
        aria-label="Pinned"
        role="img"
        className="size-3 shrink-0 text-muted-foreground/65"
      />
    )
  ) : null;

  if (variant === "slim") {
    return (
      <li
        data-thread-item={threadKey}
        {...sortableRootProps}
        {...(fileDropHandlers ?? {})}
        className={cn(
          "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
          props.isOverlayCopy === true && "relative z-20",
        )}
      >
        <Tooltip disabled={sortable?.isDragging}>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                role="button"
                tabIndex={0}
                aria-label={accessibility.label}
                aria-current={accessibility.current}
                data-testid="sidebar-row-slim"
                aria-busy={isRegeneratingTitle || undefined}
                className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {accessibleTitle}
            <ThreadProviderRail thread={thread} />
            <span
              className={cn(
                "flex shrink-0 items-center transition-opacity",
                (!props.isActive || variantAction === "unsettle") &&
                  "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            >
              {props.project ? <ProjectFavicon project={props.project} className="size-4" /> : null}
            </span>
            {draftIndicator}
            {title}
            <ThreadProviderChip thread={thread} />
            {pinIndicator}
            {subagentIndicator}
            {terminalStatusIcon}
            {isRegeneratingTitle ? (
              <span role="status" className="sr-only">
                Regenerating title
              </span>
            ) : null}
            {prBadge}
            {/* The verb replaces the status slot only while there is a verb to show. A drag that
                stays in its own section has none, and the carried copy would otherwise draw an
                empty gap where the row's own status was. */}
            {dragDestination !== null ? (
              dragDestination
            ) : (
              <span
                className={cn(
                  "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end",
                  props.sweepAction !== null && "hidden",
                )}
              >
                <span
                  className={cn(
                    "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                    !isWoke && "group-any-hover/sidebar-row:opacity-0",
                  )}
                >
                  {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                    <span className="text-xs text-info-foreground tabular-nums">
                      {props.snoozeWakeLabelText}
                    </span>
                  ) : isWoke ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Dismiss Woke notification"
                            onClick={handleAcknowledgeWokeClick}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <AlarmClockIcon aria-hidden className="size-3" />
                            <span role="status">Woke</span>
                          </button>
                        }
                      />
                      <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                    </Tooltip>
                  ) : (
                    <span className="text-xs">
                      <RelativeTimeLabel
                        timestamp={
                          variantAction === "unsettle"
                            ? resolveSettledThreadTimestamp(thread)
                            : threadTimeTimestamp(thread)
                        }
                      />
                    </span>
                  )}
                </span>
                {variantAction === "unsnooze" ? (
                  !props.snoozeSupported ? null : (
                    <button
                      type="button"
                      aria-label="Wake thread now"
                      onClick={handleUnsnoozeClick}
                      onPointerDown={handleActionPointerDown}
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                        isWoke && "group-any-hover/sidebar-row:static",
                      )}
                    >
                      <AlarmClockOffIcon className="mb-px size-3" />
                    </button>
                  )
                ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Un-settle thread"
                          onClick={handleUnsettleClick}
                          onPointerDown={handleActionPointerDown}
                          className={cn(
                            "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                            isWoke && "group-any-hover/sidebar-row:static",
                          )}
                        />
                      }
                    >
                      <Undo2Icon className="mb-px size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Un-settle thread</TooltipPopup>
                  </Tooltip>
                ) : (
                  <button
                    type="button"
                    aria-label="Settle thread"
                    onClick={handleSettleClick}
                    onPointerDown={handleActionPointerDown}
                    className={cn(
                      "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                      isWoke && "group-any-hover/sidebar-row:static",
                    )}
                  >
                    <CheckIcon className="size-3" />
                  </button>
                )}
              </span>
            )}
            {props.sweepAction !== null ? dragDestination : null}
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  const diff = latestRunDiff(thread);

  return (
    <li
      data-thread-item={threadKey}
      {...sortableRootProps}
      {...(fileDropHandlers ?? {})}
      className={cn(
        "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]",
        props.isOverlayCopy === true && "relative z-20",
      )}
    >
      <Tooltip disabled={snoozeMenuOpen || sortable?.isDragging}>
        <TooltipTrigger
          render={
            <div
              ref={rowRef}
              role="button"
              tabIndex={0}
              aria-label={accessibility.label}
              aria-current={accessibility.current}
              data-testid="sidebar-row-card"
              aria-busy={isRegeneratingTitle || undefined}
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {accessibleTitle}
          <ThreadProviderRail thread={thread} className="z-10" />
          <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
            <div className="flex h-5 w-full min-w-0 items-center gap-1.5">
              {draftIndicator}
              {props.project ? (
                <ProjectFavicon project={props.project} className="size-4 shrink-0" />
              ) : null}
              {props.projectDisplayName ? (
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-secondary-label text-xs",
                    shouldRecede ? "font-normal" : "font-medium",
                  )}
                >
                  {props.projectDisplayName}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {/* In the card's header line, beside the project name — where the eye already
                  goes for context — so the title line below stays untouched. */}
              <ThreadProviderChip thread={thread} />
              {pinIndicator}
              {dragDestination !== null ? (
                dragDestination
              ) : (
                <span
                  className={cn(
                    "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
                    props.sweepAction !== null && "hidden",
                  )}
                >
                  <span
                    className={cn(
                      isWokeStatus
                        ? "pointer-events-auto"
                        : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0",
                      "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",
                      snoozeMenuOpen && "pointer-events-none absolute right-0 opacity-0",
                    )}
                  >
                    {topStatus ? (
                      isWokeStatus ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Dismiss Woke notification"
                                onClick={handleAcknowledgeWokeClick}
                                className={cn(
                                  "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                  topStatus.className,
                                )}
                              >
                                <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                                <span role="status">{topStatus.label}</span>
                              </button>
                            }
                          />
                          <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                        </Tooltip>
                      ) : (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 font-medium",
                            topStatus.className,
                          )}
                        >
                          {topStatus.icon === "working" ? (
                            <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "waiting" ? (
                            <CircleDotDashedIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "input" ? (
                            <MessageCircleQuestionIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "approval" ? (
                            <ShieldQuestionIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "failed" ? (
                            <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "done" ? (
                            <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                          ) : null}
                          {/* The label alone is the live region: a role="status"
                            wrapper around the ticking duration would make
                            screen readers announce every second. */}
                          <span role="status">{topStatus.label}</span>
                          {status === "working" ? (
                            <span aria-hidden>
                              <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                            </span>
                          ) : status === "waiting" ? (
                            <span aria-hidden>
                              <WorkingDuration startedAt={thread.latestRun?.completedAt ?? null} />
                            </span>
                          ) : null}
                        </span>
                      )
                    ) : (
                      <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />
                    )}
                  </span>
                  {props.settlementSupported || showSnoozeButton || hasUnsentDraft ? (
                    <span
                      className={cn(
                        // focus-visible, not focus-within: a mouse click leaves
                        // the Settle button focused, and a plain focus-within
                        // would keep the controls pinned over the status label
                        // once the pointer moves away (e.g. after a failed
                        // settle) instead of cross-fading back.
                        "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
                        snoozeMenuOpen && "pointer-events-auto static opacity-100",
                      )}
                    >
                      {hasUnsentDraft ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Discard draft"
                                onClick={handleDiscardDraftClick}
                                className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                              />
                            }
                          >
                            <XIcon className="size-3.5" />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Discard draft</TooltipPopup>
                        </Tooltip>
                      ) : null}
                      {showSnoozeButton ? (
                        <SnoozeMenuButton
                          open={snoozeMenuOpen}
                          onOpenChange={setSnoozeMenuOpen}
                          onSnooze={handleSnoozePreset}
                          timestampFormat={props.timestampFormat}
                        />
                      ) : null}
                      {props.settlementSupported ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Settle thread"
                                onClick={handleSettleClick}
                                onPointerDown={handleActionPointerDown}
                                className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                              />
                            }
                          >
                            <CheckIcon className="size-3.5" />
                            Settle
                          </TooltipTrigger>
                          <TooltipPopup>Settle thread</TooltipPopup>
                        </Tooltip>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              )}
              {props.sweepAction !== null ? dragDestination : null}
            </div>
            <div className="mt-1 flex min-w-0">
              {title}
              {isRegeneratingTitle ? (
                <span role="status" className="sr-only">
                  Regenerating title
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
              {/* Always the branch. The plan step used to take this slot while
                  working, but it truncated to a half-sentence and dropped the
                  branch, so the row lost its most stable identifier. A Queue
                  note sits after it rather than in its place; both grow from
                  zero so neither squeezes the other out of a narrow row. */}
              {thread.branch ? (
                <>
                  <ThreadWorktreeIndicator thread={thread} />
                  <span className="flex min-w-0 flex-1 text-muted-foreground/40">
                    <MiddleTruncate value={thread.branch} showTitle={false} />
                  </span>
                </>
              ) : props.queueNote ? null : showsScratchMachine ? (
                <>
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={props.environmentMachine}
                    className="size-3 shrink-0 text-muted-foreground/40"
                  />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground/40">
                    {props.scratchMachineLabel}
                  </span>
                </>
              ) : (
                <span className="flex-1" />
              )}
              {props.queueNote ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="min-w-0 flex-1 basis-0 truncate text-sidebar-muted-foreground/60">
                        {QUEUED_ON_ANOTHER_DEVICE_SHORT}
                      </span>
                    }
                  />
                  <TooltipPopup side="top">{props.queueNote}</TooltipPopup>
                </Tooltip>
              ) : null}
              {subagentIndicator}
              {terminalStatusIcon}
              {prBadge}
              {diff ? (
                <span className="shrink-0 font-mono">
                  <span className="text-diff-addition-foreground">
                    +{formatDiffCount(diff.insertions)}
                  </span>{" "}
                  <span className="text-diff-deletion-foreground">
                    −{formatDiffCount(diff.deletions)}
                  </span>
                </span>
              ) : null}
              <span
                aria-hidden
                className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
              >
                {isRemote && !showsScratchMachine ? (
                  <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={props.environmentMachine}
                      className="size-3.5"
                    />
                  </span>
                ) : null}
                <SidebarProviderStack
                  thread={thread}
                  providerEntryByInstanceId={props.providerEntryByInstanceId}
                />
              </span>
            </div>
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );
});

function latestRunDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  void thread;
  return null;
}

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const { thread } = props;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const onFileDropThreads = props.onFileDropThreads;
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsFileDragOver,
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  return (
    <li role="presentation" className="list-none" {...fileDropHandlers}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              id={props.resultId}
              data-search-result-key={scopedThreadKey(threadRef)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={accessibility.current}
              aria-describedby={`${props.resultId}-pr`}
              aria-label={accessibility.label}
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon
              project={props.project}
              className={cn(
                "size-4 shrink-0 transition-opacity",
                props.isSettled &&
                  !props.isRouteActive &&
                  !props.isHighlighted &&
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  props.isSettled
                    ? "font-normal text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                    : "font-medium text-foreground",
                  (props.isHighlighted || props.isRouteActive) && "text-foreground",
                  thread.titleRegeneration != null && "opacity-55",
                )}
              >
                {thread.title}
              </span>
              <span id={`${props.resultId}-pr`} className="contents">
                <ThreadSearchPullRequestNumber
                  thread={thread}
                  query={props.searchQuery}
                  enabled={leaseLiveStatus}
                  settled={props.isSettled}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
                <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />
              </span>
            </span>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={thread}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
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
  } = useSidebarThreads({
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    routeThreadKey,
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
    routeThreadKey,
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
            currentThreadId: routeThreadKey,
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
    routeTerminalOpen,
    routeThreadKey,
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
            isActive: routeThreadKey === threadKey,
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
                        isRouteActive={routeThreadKey === threadKey}
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

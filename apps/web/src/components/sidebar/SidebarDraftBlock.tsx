import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, ListPlusIcon, ListXIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { type QueueRowSortableBag } from "../SidebarQueueBlock";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useThreadQueueStore } from "../../threadQueueStore";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import type { ContextMenuSource } from "@t3tools/contracts";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { composerFileLinksToPlainText } from "@t3tools/shared/composerInlineTokens";
import { T, useGT, Var } from "gt-react";
import { SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { cn } from "~/lib/utils";
import { useTerminalLabelsByThreadKey } from "~/state/terminalSessions";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import {
  draftPenClassName,
  draftSurfaceClassName,
  JUMP_HINT_SLOT_CLASS_NAME,
  JumpHintBadge,
} from "./SidebarThreadRow";

const EMPTY_COMPOSER_PARTS = {
  prompt: "",
  images: [],
  persistedAttachments: [],
  files: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
} as const;

/** Terminal labels for draft threads; an unsent draft stays listed while it has a terminal. */
export function useDraftTerminalLabels(): ReadonlyMap<string, string> {
  const environmentIds = useComposerDraftStore((store) => {
    const ids = new Set<string>();
    for (const session of Object.values(store.draftThreadsByThreadKey)) {
      if (session.promotedTo == null) ids.add(session.environmentId);
    }
    return [...ids].toSorted().join("\n");
  });
  return useTerminalLabelsByThreadKey(
    environmentIds === "" ? [] : (environmentIds.split("\n") as EnvironmentId[]),
  );
}

export function draftTerminalLabel(
  session: DraftSessionState,
  terminalLabels: ReadonlyMap<string, string>,
): string | null {
  return terminalLabels.get(`${session.environmentId}:${session.threadId}`) ?? null;
}

const NOT_STARTED_EXPANDED_KEY = "t3code:sidebar:not-started-expanded";

export const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState | null;
  terminalLabel: string | null;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  jumpLabel: string | null;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  /** In the sidebar Queue: the row offers removal instead of adding. */
  queued: boolean;
  onToggleQueue: (draftId: DraftId, session: DraftSessionState) => void;
  sortable?: QueueRowSortableBag;
  /** See SidebarThreadRow: the drag presentation belongs to the copy, not the row left behind. */
  isOverlayCopy?: boolean | undefined;
  onContextMenu: (
    draftId: DraftId,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const { draftId, onContextMenu, onDiscard, onNavigate, onToggleQueue, session, sortable } = props;
  const composer = props.composer ?? EMPTY_COMPOSER_PARTS;
  const gt = useGT();
  const promptPreview =
    assistantCitationsToPlainText(
      composerFileLinksToPlainText(
        replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label),
      ),
    )
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
      : attachmentCount === 0 && props.terminalLabel !== null
        ? props.terminalLabel
        : gt("{count, plural, one {{count} attachment} other {{count} attachments}}", {
            count: attachmentCount,
          });
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: gt("Unsent draft"),
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
      onContextMenu(draftId, { x: rect.left, y: rect.bottom }, "keyboard");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(draftId);
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(draftId, { x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
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
        data-sidebar-row={`draft:${draftId}`}
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
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon aria-hidden className={draftPenClassName} />
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {props.projectDisplayName}
            </span>
            <span
              className={cn(
                "ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end",
                props.jumpLabel && JUMP_HINT_SLOT_CLASS_NAME,
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={props.queued ? gt("Remove from queue") : gt("Add to queue")}
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
                  {props.queued ? <T>Remove from queue</T> : <T>Add to queue</T>}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={gt("Discard draft")}
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  <T>Discard draft</T>
                </TooltipPopup>
              </Tooltip>
              {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground/90">{preview}</div>
        </div>
      </div>
    </li>
  );
});

const EMPTY_DRAFT_ID_SET: ReadonlySet<string> = new Set();

function listedDraftComposer(draftId: string | null): ComposerThreadDraftState | null {
  if (draftId === null) return null;
  const store = useComposerDraftStore.getState();
  const session = store.draftThreadsByThreadKey[draftId];
  const composer = store.draftsByThreadKey[draftId];
  return session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
    ? composer
    : null;
}

/**
 * Unsent drafts listed above the threads, newest first. The open draft keeps the
 * row it had on arrival (frozen content), so its row and jump number stay put.
 */
export function useSidebarDrafts(
  scopedProjectKeys: ReadonlySet<string> | null,
  routeDraftId: string | null,
  terminalLabels: ReadonlyMap<string, string>,
  // FORK: queued drafts render under Queue instead, so they take no row or jump number here.
  queuedDraftIds: ReadonlySet<string> = EMPTY_DRAFT_ID_SET,
): { draftIds: readonly DraftId[]; routeDraftComposer: ComposerThreadDraftState | null } {
  const [frozenRoute, setFrozenRoute] = useState<{
    routeDraftId: string | null;
    composer: ComposerThreadDraftState | null;
  }>({ routeDraftId: null, composer: null });
  if (frozenRoute.routeDraftId !== routeDraftId) {
    setFrozenRoute({ routeDraftId, composer: listedDraftComposer(routeDraftId) });
  }
  const routeDraftComposer =
    frozenRoute.routeDraftId === routeDraftId ? frozenRoute.composer : null;
  const draftIds = useComposerDraftStore(
    useShallow((store) => {
      const listed: [string, DraftSessionState][] = [];
      for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
        if (session.promotedTo != null) continue;
        if (queuedDraftIds.has(draftKey)) continue;
        if (
          scopedProjectKeys !== null &&
          !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
        ) {
          continue;
        }
        // Composer edits stay frozen while open; terminals come and go live.
        const isListed =
          draftTerminalLabel(session, terminalLabels) !== null ||
          (draftKey === routeDraftId
            ? routeDraftComposer !== null
            : composerDraftHasUserContent(store.draftsByThreadKey[draftKey]));
        if (isListed) listed.push([draftKey, session]);
      }
      listed.sort(([, left], [, right]) => right.createdAt.localeCompare(left.createdAt));
      return listed.map(([draftKey]) => DraftId.make(draftKey));
    }),
  );
  return { draftIds, routeDraftComposer };
}

export const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  draftIds: readonly DraftId[];
  routeDraftComposer: ComposerThreadDraftState | null;
  terminalLabels: ReadonlyMap<string, string>;
  jumpLabelByDraftId: ReadonlyMap<DraftId, string> | null;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
  onToggleDraftQueue: (draftId: DraftId, session: DraftSessionState) => void;
  onDraftContextMenu: (
    draftId: DraftId,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore(
    useShallow((store) =>
      Object.fromEntries(
        props.draftIds.map((draftId) => [draftId, store.draftsByThreadKey[draftId]] as const),
      ),
    ),
  );
  const drafts = props.draftIds.flatMap((draftId) => {
    const session = draftThreadsByThreadKey[draftId];
    const composer =
      (draftId === props.routeDraftId ? props.routeDraftComposer : null) ??
      draftsByThreadKey[draftId] ??
      null;
    return session ? [{ draftId, session, composer }] : [];
  });
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
            <T>
              Not started (0/<Var>{drafts.length}</Var>)
            </T>
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
            terminalLabel={draftTerminalLabel(session, props.terminalLabels)}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            jumpLabel={props.jumpLabelByDraftId?.get(draftId) ?? null}
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

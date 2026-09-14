import {
  ApprovalRequestId,
  CheckpointRef,
  EnvironmentId,
  MessageId,
  TurnId,
  type ComposerContextRecord,
} from "@t3tools/contracts";
import { act, createRef, useLayoutEffect, type ReactNode, type Ref } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef, MaintainScrollAtEndOptions } from "@legendapp/list/react";
import { shouldUseRestingComposerLayout } from "../composerFooterLayout";
import { useComposerFocusState } from "./useComposerFocusState";
import { renderDom } from "../../testing/renderDom";

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
      anchorMaxSize?: number;
      anchorOffset?: number;
      onReady?: (info: { anchorIndex: number }) => void;
    };
    contentInsetEndAdjustment?: number;
    className?: string;
    maintainScrollAtEnd?: boolean | MaintainScrollAtEndOptions;
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean;
          size?: boolean;
          shouldRestorePosition?: (item: { id: string }) => boolean;
        };
    ref?: Ref<LegendListRef>;
  }) => {
    if (props.anchoredEndSpace) {
      props.anchoredEndSpace.onReady?.({ anchorIndex: props.anchoredEndSpace.anchorIndex });
    }
    return (
      <div
        data-testid={legendListTestId}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-anchor-max-size={props.anchoredEndSpace?.anchorMaxSize}
        data-anchor-offset={props.anchoredEndSpace?.anchorOffset}
        data-anchor-on-ready={Boolean(props.anchoredEndSpace?.onReady)}
        data-content-inset-end={props.contentInsetEndAdjustment}
        data-class-name={props.className}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-footer-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.footerLayout
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === "object"
            ? "object"
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
        data-maintain-visible-content-position-restore={
          typeof props.maintainVisibleContentPosition === "object"
            ? Boolean(props.maintainVisibleContentPosition.shouldRestorePosition)
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;
let resolvePreviewAnnotationImage: typeof import("./MessagesTimeline").resolvePreviewAnnotationImage;

// The DOM this file needs is the real one now: it runs under the `dom` project, so the
// stub `window`/`document`/`Element` this suite used to install for the `node` environment
// would replace a working DOM with a broken one.
//
// No per-hook timeout here on purpose. The `dom` project sets hookTimeout to 120s
// precisely because these imports are heavy, and a local override could only lower
// it. This import measures ~3.5s idle but exceeded a 30s cap twice during full-gate
// runs on 2026-09-07, failing the suite at import with zero tests failing.
beforeAll(async () => {
  ({ MessagesTimeline, resolvePreviewAnnotationImage } = await import("./MessagesTimeline"));
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaries: [],
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    onArmRevertPromptRestore: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string) {
  const entry = buildUserTimelineEntry(text);
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "assistant" as const,
    },
  };
}

/** LegendList's mock exposes the end-following decision as this attribute. */
const MAINTAIN_SCROLL_AT_END = '[data-maintain-scroll-at-end="enabled"]';

/** Accessible names carrying a fragment - the failure notice is label-only, never visible text. */
function ariaLabelsContaining(
  view: Awaited<ReturnType<typeof renderDom>>,
  fragment: string,
): string[] {
  return view
    .findAll("[aria-label]")
    .map((element) => element.getAttribute("aria-label") ?? "")
    .filter((label) => label.includes(fragment));
}

/** Every attribute value in the tree, for "this string reached no attribute either" checks. */
function attributeValues(view: Awaited<ReturnType<typeof renderDom>>): string[] {
  return view.findAll("*").flatMap((element) => [...element.attributes].map((a) => a.value));
}

describe("MessagesTimeline", () => {
  it("renders elapsed time for a completed turn", async () => {
    const turnId = TurnId.make("turn-with-fold");
    const assistantEntry = buildAssistantTimelineEntry("Done.");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        latestTurn={{
          turnId,
          state: "completed",
          startedAt: "2026-03-17T19:12:20.000Z",
          completedAt: "2026-03-17T19:12:28.000Z",
        }}
        timelineEntries={[
          {
            id: "work-entry-with-fold",
            kind: "work",
            createdAt: "2026-03-17T19:12:22.000Z",
            entry: {
              id: "work-with-fold",
              createdAt: "2026-03-17T19:12:22.000Z",
              turnId,
              label: "Ran command",
              tone: "tool",
              toolLifecycleStatus: "completed",
            },
          },
          {
            ...assistantEntry,
            message: { ...assistantEntry.message, turnId },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("Worked for 8.0s");
  });

  it("keeps assistant changed-files headers sticky below the thread header", async () => {
    const assistantMessageId = MessageId.make("message-assistant-with-files");
    const turnId = TurnId.make("turn-with-files");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        latestTurn={{
          turnId,
          state: "completed",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: MESSAGE_CREATED_AT,
        }}
        timelineEntries={[
          {
            id: "entry-assistant-with-files",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the fixture.",
              turnId,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
        turnDiffSummaries={[
          {
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-with-files"),
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
            assistantMessageId,
            completedAt: MESSAGE_CREATED_AT,
          },
        ]}
      />,
    );

    expect(view.find(".sticky.top-2.z-10")).not.toBeNull();
    expect(view.find(".self-start")).toBeNull();
    expect(view.find(".whitespace-nowrap")).not.toBeNull();
    expect(view.find(".size-3")).not.toBeNull();
    expect(view.find('[aria-label="Collapse all folders"]')).toBeNull();
    expect(view.find('[aria-label="Open diff"]')).not.toBeNull();
    expect(view.text()).toContain("1 changed file");
  });

  it("treats only the strict list end as the live edge", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapCurrentIndex,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapHitStripWidth,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapInteractiveWidth,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
    // Within the pixel band above the content bottom counts as the end...
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 1170,
        scrollLength: 800,
      }),
    ).toBe(true);
    // ...but half a viewport up (LegendList's isNearEnd territory) does not.
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 900,
        scrollLength: 800,
      }),
    ).toBe(false);
    // LegendList's isAtEnd is true anywhere within the composer-height band
    // (it subtracts the inset); the last row is still hidden under the
    // composer there, so the flag must not short-circuit the geometry.
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: true,
        contentLength: 2000,
        scroll: 1100,
        scrollLength: 800,
      }),
    ).toBe(false);
    // Geometry missing (older state shape): fall back to the strict flag.
    expect(resolveTimelineIsAtEnd({ isAtEnd: false })).toBe(false);

    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    expect(
      resolveTimelineMinimapCurrentIndex({
        scrollTop: 100,
        scrollBottom: 500,
        itemBounds: [
          { top: 80, height: 20 },
          { top: 120, height: 20 },
          { top: 220, height: 20 },
        ],
      }),
    ).toBe(1);
    expect(
      resolveTimelineMinimapCurrentIndex({
        scrollTop: 150,
        scrollBottom: 200,
        itemBounds: [
          { top: 80, height: 20 },
          { top: 120, height: 20 },
          { top: 220, height: 20 },
        ],
      }),
    ).toBe(1);
    expect(
      resolveTimelineMinimapCurrentIndex({
        scrollTop: 0,
        scrollBottom: 50,
        itemBounds: [{ top: 80, height: 20 }],
      }),
    ).toBeNull();
    expect(resolveTimelineMinimapHasPersistentGutter(832)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true);

    // No usable gutter (zoomed in / narrow pane): the strip must go inert
    // instead of overlaying the centered content column.
    expect(resolveTimelineMinimapHitStripWidth(768)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(792)).toBe(0);
    // Partial gutter: strip shrinks to what fits between the viewport edge
    // and the content column.
    expect(resolveTimelineMinimapHitStripWidth(820)).toBe(14);
    // Full gutter: unchanged 40px-wide strip.
    expect(resolveTimelineMinimapHitStripWidth(872)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(1400)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(0)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN)).toBe(0);

    // The collapsed target stays narrow, but an open preview keeps its full
    // 20rem width plus the 2rem offset from the minimap rail interactive.
    expect(resolveTimelineMinimapInteractiveWidth(0, false)).toBe(0);
    expect(resolveTimelineMinimapInteractiveWidth(14, false)).toBe(14);
    expect(resolveTimelineMinimapInteractiveWidth(40, false)).toBe(40);
    expect(resolveTimelineMinimapInteractiveWidth(0, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(14, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(40, true)).toBe("22rem");
  });

  it("gives browser documents separate preview and download controls", async () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "attachment-report-pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            previewUrl: "https://environment.test/api/assets/report.pdf",
          },
        ],
      },
    };

    const view = await renderDom(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);

    expect(view.find('[aria-label="Preview report.pdf"]')).not.toBeNull();
    expect(view.find('[aria-label="Download report.pdf"]')).not.toBeNull();
    expect(view.find('[download="report.pdf"]')).toBeNull();
    expect(view.find('[alt="report.pdf"]')).toBeNull();
  });

  it("renders video attachments with the shared video player", async () => {
    const entry = {
      ...buildUserTimelineEntry("Watch the demo."),
      message: {
        ...buildUserTimelineEntry("Watch the demo.").message,
        attachments: [
          {
            type: "file" as const,
            id: "attachment-demo-mp4",
            name: "demo.mp4",
            mimeType: "video/mp4",
            sizeBytes: 42,
            previewUrl: "https://environment.test/api/assets/demo.mp4",
          },
        ],
      },
    };

    const view = await renderDom(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);

    expect(view.find("video")).not.toBeNull();
    expect(view.find('[aria-label="demo.mp4"]')).not.toBeNull();
    expect(view.find("video")?.hasAttribute("controls")).toBe(true);
    expect(view.text()).not.toContain("Expand demo.mp4");
    expect(view.find('[aria-label="Expand demo.mp4"]')).toBeNull();
  });

  it("shows the filename while an optimistic video is unavailable", async () => {
    const entry = {
      ...buildUserTimelineEntry("Uploading the demo."),
      message: {
        ...buildUserTimelineEntry("Uploading the demo.").message,
        attachments: [
          {
            type: "file" as const,
            id: "optimistic-demo-mp4",
            name: "pending-demo.mp4",
            mimeType: "video/mp4",
            sizeBytes: 42,
            downloadable: false,
          },
        ],
      },
    };

    const view = await renderDom(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);

    expect(view.find("video")).toBeNull();
    // The bare filename, rendered as its own element rather than as a player.
    expect(view.findAll("div").some((element) => element.textContent === "pending-demo.mp4")).toBe(
      true,
    );
  });
  it("renders an ordinary file download button without creating its URL in advance", async () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "attachment-report-pdf",
            name: "archive.zip",
            mimeType: "application/zip",
            sizeBytes: 42,
          },
        ],
      },
    };

    const view = await renderDom(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);

    const download = view.find<HTMLButtonElement>('[aria-label="Download archive.zip"]');
    expect(download?.tagName).toBe("BUTTON");
    expect(download?.type).toBe("button");
    // The point is the absence of an anchor: no object URL is minted until the
    // button is pressed. The button's styling is not part of that contract.
    expect(view.find("a[href]")).toBeNull();
  });

  it("does not download an optimistic file before the server supplies its attachment ID", async () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "composer-local-report",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            downloadable: false,
          },
        ],
      },
    };

    const view = await renderDom(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);

    expect(view.text()).toContain("report.pdf");
    expect(view.find('[aria-label="Download report.pdf"]')).toBeNull();
  });

  it("renders unknown attachment types as inert rows instead of crashing", async () => {
    const entry = {
      ...buildUserTimelineEntry("Play the recording."),
      message: {
        ...buildUserTimelineEntry("Play the recording.").message,
        attachments: [
          {
            // A newer server can introduce attachment types this build does
            // not know. They ride the open contract member.
            type: "recording",
            id: "attachment-voice-memo",
            name: "voice-memo.ogg",
            mimeType: "audio/ogg",
            sizeBytes: 42,
          },
        ],
      },
    };

    const view = await renderDom(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);

    expect(view.text()).toContain("voice-memo.ogg");
    expect(view.find('[aria-label="Download voice-memo.ogg"]')).toBeNull();
    expect(view.find('[alt="voice-memo.ogg"]')).toBeNull();
    expect(view.find("a[href]")).toBeNull();
  });

  it("keeps reserved end space when tool work starts while reading history", async () => {
    const turnId = TurnId.make("turn-with-active-tool");
    const firstEntry = buildUserTimelineEntry("Run the command.");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        anchorMessageId={firstEntry.message.id}
        liveFollowEnabled={false}
        timelineEntries={[
          firstEntry,
          {
            id: "entry-active-tool",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-active-tool",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-active-tool",
              label: "Run command",
              tone: "tool",
              itemType: "command_execution",
              command: "git status",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    expect(view.find('[data-anchor-index="0"]')).not.toBeNull();
    expect(view.find(MAINTAIN_SCROLL_AT_END)).toBeNull();
  });

  it("hands end-following back to the list once the send anchor is released", async () => {
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
      },
    };
    const timelineEntries = [firstEntry, secondEntry];

    // While the send anchor holds the end space open, ChatView owns streaming
    // scrolls and LegendList must not re-pin behind it.
    const anchored = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={firstEntry.message.id}
        timelineEntries={timelineEntries}
      />,
    );
    expect(anchored.find(MAINTAIN_SCROLL_AT_END)).toBeNull();

    // Dropping the anchor is what actually gives end-following back, so
    // returning to the live edge has to release it — re-enabling live follow
    // alone leaves nothing pinned to the stream.
    const released = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={null}
        timelineEntries={timelineEntries}
      />,
    );
    expect(released.find(MAINTAIN_SCROLL_AT_END)).not.toBeNull();

    // Reading history still wins over both.
    const readingHistory = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={null}
        liveFollowEnabled={false}
        timelineEntries={timelineEntries}
      />,
    );
    expect(readingHistory.find(MAINTAIN_SCROLL_AT_END)).toBeNull();
  });

  it("renders collapse controls for long user messages", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(view.text()).toContain("Show full message");
    expect(view.find(MAINTAIN_SCROLL_AT_END)).not.toBeNull();
    expect(view.find('[data-maintain-scroll-at-end-animated="false"]')).not.toBeNull();
    expect(view.find('[data-maintain-scroll-at-end-data-change="true"]')).not.toBeNull();
    expect(view.find('[data-maintain-scroll-at-end-footer-layout="false"]')).not.toBeNull();
    expect(view.find('[data-maintain-scroll-at-end-item-layout="true"]')).not.toBeNull();
    expect(view.find('[data-maintain-scroll-at-end-layout="true"]')).not.toBeNull();
    expect(view.find('[data-user-message-collapsed="true"]')).not.toBeNull();
    expect(view.find('[data-user-message-fade="true"]')).not.toBeNull();
    expect(view.find('[data-user-message-footer="true"]')).not.toBeNull();
  });

  it("does not render collapse controls for short user messages", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(view.text()).not.toContain("Show full message");
    expect(view.find('[data-user-message-collapsible="false"]')).not.toBeNull();
    expect(view.find(".rounded-2xl.bg-message.p-3")).not.toBeNull();
  });

  it("preserves arbitrary XML-like tags and comparisons in rendered user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Without reading a file, do you have <global-agent-instructions scope="workspace">',
              'Before <nested data-value="a&b">inside</nested> after',
              "</global-agent-instructions> in your context?",
              "Comparison: 2 < 3 and 5 > 4.",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(view.text()).toContain('<global-agent-instructions scope="workspace">');
    expect(view.text()).toContain('Before <nested data-value="a&b">inside</nested> after');
    expect(view.text()).toContain("</global-agent-instructions> in your context?");
    expect(view.text()).toContain("Comparison: 2 < 3 and 5 > 4.");
  });

  it("preserves XML-like source inside user code spans and fences", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Inline `<tag attr="x">`',
              "",
              "```xml",
              '<root><child enabled="true" /></root>',
              "```",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(view.find("code[data-inline-code]")?.textContent).toBe('<tag attr="x">');
    expect(view.text()).toContain('<root><child enabled="true" /></root>');
  });

  it("does not render markdown title attributes in user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '[link](https://example.com "link tip") ![image](https://example.com/image.png "image tip")',
          ),
        ]}
      />,
    );

    expect(view.find('a[href="https://example.com"]')).not.toBeNull();
    expect(view.find('img[src="https://example.com/image.png"]')).not.toBeNull();
    expect(view.find('[title="link tip"]')).toBeNull();
    expect(view.find('[title="image tip"]')).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">',
          ),
        ]}
      />,
    );

    expect(view.text()).toContain("<script>globalThis.__t3Xss = 1</script>");
    expect(view.text()).toContain('<img src="x" onerror="globalThis.__t3Xss = 2">');
    expect(view.find("script")).toBeNull();
    expect(view.find("img")).toBeNull();
  });

  it("continues to render sanitized raw HTML in assistant messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry("<details><summary>More</summary>Details</details>"),
        ]}
      />,
    );

    expect(view.find("[data-markdown-details]")).not.toBeNull();
    expect(view.text()).toContain("More");
    expect(view.text()).not.toContain("<details>");
  });

  it("sanitizes executable HTML while preserving supported assistant markup", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry(
            [
              '<details open onclick="globalThis.__t3Xss = 1">',
              "<summary>Safe details</summary>",
              "<script>globalThis.__t3Xss = 2</script>",
              '<img src="x" onerror="globalThis.__t3Xss = 3">',
              '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
              "</details>",
            ].join(""),
          ),
        ]}
      />,
    );

    expect(view.find("[data-markdown-details]")).not.toBeNull();
    expect(view.text()).toContain("Safe details");
    expect(view.find("script")).toBeNull();
    expect(view.find("[onclick]")).toBeNull();
    expect(view.find("[onerror]")).toBeNull();
    expect(attributeValues(view).some((value) => value.includes("javascript:"))).toBe(false);
    expect(view.text()).not.toContain("globalThis.__t3Xss");
    expect(attributeValues(view).some((value) => value.includes("globalThis.__t3Xss"))).toBe(false);
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(view.find(".lucide-terminal")).not.toBeNull();
    // Upstream #11265: the chip is substituted AT the mention, inside the
    // prompt's own paragraph, rather than appended after it.
    expect(
      view
        .findAll("p")
        .some((element) => element.textContent?.endsWith("yoo what's Terminal 1 lines 1-5 mean")),
    ).toBe(true);
    expect(view.text()).toContain("Show full message");
  });

  it("renders chips for standalone element-pick context messages", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  url: https://example.com/dashboard",
              "  selector: button.submit",
              "  source: /repo/src/Button.tsx:12:5",
              "  html:",
              '  <button class="submit">Save</button>',
              "</element_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(view.text()).toContain("SubmitButton");
    expect(view.text()).not.toContain("<element_context");
    // The raw tag must not have become a real (unknown) element either.
    expect(
      view.findAll("*").some((element) => element.tagName.toLowerCase() === "element_context"),
    ).toBe(false);
  });

  it("keeps the copy button for collapsed long user messages", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(view.find('[aria-label="Copy link"]')).not.toBeNull();
    expect(view.find('[data-user-message-collapsed="true"]')).not.toBeNull();
    expect(view.find('[data-user-message-footer="true"]')).not.toBeNull();
  });

  it("renders context compaction entries in the normal work log", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Compacted context 899K → 19K tokens",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("Compacted context 899K → 19K tokens");
  });

  it("summarizes changed files in one line", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(view.text()).toContain("Changed 1 file");
    expect(view.text()).not.toContain(
      "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts",
    );
  });

  it("keeps mixed-success tool groups neutral", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Run search",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("Ran 2 commands");
    expect(view.find('[aria-label="Tool call failed"]')).toBeNull();
  });

  it("keeps the collapsed summary icon neutral when the group ends in a failure", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
            },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("Ran 2 commands");
    expect(view.find(".lucide-terminal")).not.toBeNull();
    expect(view.find(".lucide-x")).toBeNull();
    expect(view.find(".text-destructive")).toBeNull();
    // The failure stays discoverable for screen readers.
    expect(ariaLabelsContaining(view, "tool call failed")).not.toHaveLength(0);
  });

  it("renders trailing tool calls as part of the terminal assistant block", async () => {
    const turnId = TurnId.make("turn-trailing-tools");
    const assistantMessageId = MessageId.make("assistant-trailing-tools");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        latestTurn={{
          turnId,
          state: "error",
          startedAt: "2026-03-17T19:12:20.000Z",
          completedAt: "2026-03-17T19:12:30.000Z",
        }}
        timelineEntries={[
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "I’ll search for it now.",
              turnId,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
          {
            id: "trailing-work-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "trailing-work",
              createdAt: "2026-03-17T19:12:30.000Z",
              turnId,
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
            },
          },
        ]}
      />,
    );

    // `querySelectorAll` yields document order, which is the render order this pins.
    const rowIds = view
      .findAll("[data-timeline-row-id]")
      .map((row) => row.getAttribute("data-timeline-row-id"));
    const messageIndex = rowIds.indexOf("assistant-entry");
    const toolIndex = rowIds.indexOf("trailing-work-entry");
    const metaIndex = rowIds.indexOf("assistant-meta:assistant-trailing-tools");
    expect(messageIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(messageIndex);
    expect(metaIndex).toBeGreaterThan(toolIndex);
    expect(view.text().match(/I’ll search for it now\./gu)).toHaveLength(1);
  });

  it("keeps mixed work logs neutral after a later tool call succeeds", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Run search",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
            },
          },
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("Ran 2 commands and received 1 update");
    expect(view.find('[aria-label="Hidden work includes a failure"]')).toBeNull();
  });

  it("shows the one-line label for a live tool group", async () => {
    const turnId = TurnId.make("turn-live");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: "entry-live",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-live",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-live",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("Working for");
    expect(view.text()).toContain("Running pnpm");
  });

  it("scopes a live row failure to the tool named by the row", async () => {
    const turnId = TurnId.make("turn-live");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-failed",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-failed",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm lint",
              toolLifecycleStatus: "failed",
            },
          },
          {
            id: "entry-running",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-running",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-running",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("Running pnpm");
    expect(ariaLabelsContaining(view, "tool call failed")).toHaveLength(0);
  });

  it("renders initial thinking as the shared live activity row", async () => {
    const turnId = TurnId.make("turn-live");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[]}
      />,
    );

    expect(view.text()).toContain("Thinking");
    expect(view.find(".lucide-brain")).not.toBeNull();
    expect(view.find('[data-timeline-row-id="live-activity-row"]')).not.toBeNull();
  });

  it("keeps the completed command in the shared activity row with a present-tense label", async () => {
    const turnId = TurnId.make("turn-live");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: "entry-completed",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-completed",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-completed",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm lint",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("Running pnpm");
    expect(view.find(".lucide-terminal")).not.toBeNull();
    expect(view.text()).not.toContain("Ran pnpm");
    expect(view.text()).not.toContain("Thinking");
    expect(view.find('[data-timeline-row-kind="thinking"]')).toBeNull();
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    // Upstream #11265 turned the inline card into a reference chip: the file and
    // range name the comment, and the body/diff live in the review surface. The
    // raw tags must still never reach the reader.
    expect(view.text()).toContain("contextWindow.test.ts L47 to L58");
    expect(view.find(".lucide-message-circle")).not.toBeNull();
    expect(view.findAll("*").some((element) => element.textContent === "Review comment")).toBe(
      false,
    );
    expect(view.text()).not.toContain("<review_comment");
    expect(view.text()).not.toContain("</review_comment>");
  });

  it("renders file review comments as source code instead of diffs", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-source-comment"),
              role: "user",
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                "Clarify this.",
                "```md",
                "# Plan",
                "- Step one",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(view.text()).toContain("plan.md L1 to L2");
    expect(view.text()).not.toContain("review_comment");
    // A file comment is not a diff, so it must never render one.
    expect(view.find('[data-testid="file-diff"]')).toBeNull();
  });

  it("offers to load earlier turns when older history exists beyond the window", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Hello")]}
        loadEarlier={{ loading: false, onLoadEarlier: () => {} }}
      />,
    );

    expect(view.text()).toContain("Load earlier turns");
  });

  it("hides the load-earlier control on a thread that starts at the beginning", async () => {
    // A thread whose snapshot covered its whole history has nothing older; a
    // permanently visible control there would be noise on every short thread.
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Hello")]}
        loadEarlier={null}
      />,
    );

    expect(view.text()).not.toContain("Load earlier turns");
  });

  it("disables the load-earlier control while a page is in flight", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Hello")]}
        loadEarlier={{ loading: true, onLoadEarlier: () => {} }}
      />,
    );

    expect(view.text()).toContain("Loading earlier turns");
    // The `disabled` PROPERTY of the control, not the substring "disabled": the class list
    // carries `disabled:` Tailwind variants, so the markup check matched unconditionally.
    const loadEarlier = view
      .findAll<HTMLButtonElement>("button")
      .find((button) => button.textContent?.includes("Loading earlier turns"));
    expect(loadEarlier?.disabled).toBe(true);
  });

  it("keeps the top spacer when the load-earlier control is shown", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Hello")]}
        topFadeEnabled
        loadEarlier={{ loading: false, onLoadEarlier: () => {} }}
      />,
    );

    // Retargeted for upstream #8799, which moved this spacer from a literal
    // padding to the shared titlebar scroll-fade variable. Same subject.
    expect(
      view.find('[class~="pt-[var(--workspace-titlebar-scroll-fade-height)]"]'),
    ).not.toBeNull();
    expect(view.text()).toContain("Load earlier turns");
  });

  it("renders attachment chips bound to server ids and hides their file rows", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-attachments",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-attachments"),
              role: "user",
              text: "See ![shot.png](t3-context://v1/image/img-1) and [notes.txt](t3-context://v1/file/file-1).",
              attachments: [
                {
                  type: "image",
                  id: "thread-1-aaa",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 3,
                },
                {
                  type: "file",
                  id: "thread-1-bbb",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: 3,
                },
                {
                  type: "file",
                  id: "thread-1-ccc",
                  name: "legacy.txt",
                  mimeType: "text/plain",
                  sizeBytes: 3,
                },
              ],
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    contextId: "img-1" as never,
                    kind: "image",
                    label: "shot.png",
                    attachmentId: "thread-1-aaa",
                    name: "shot.png",
                    mimeType: "image/png",
                    sizeBytes: 3,
                  },
                  {
                    version: 1,
                    contextId: "file-1" as never,
                    kind: "file",
                    label: "notes.txt",
                    attachmentId: "thread-1-bbb",
                    name: "notes.txt",
                    mimeType: "text/plain",
                    sizeBytes: 3,
                  },
                ],
              },
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    // Images report their size like every other attachment chip.
    expect(view.container.innerHTML).toContain('aria-label="Image attachment, shot.png, 1 KB"');
    // Selection copy re-emits chips as their canonical links.
    expect(view.container.innerHTML).toContain(
      'data-markdown-copy="![shot.png](t3-context://v1/image/img-1)"',
    );
    expect(view.container.innerHTML).toContain('aria-label="File attachment, notes.txt, 1 KB"');
    expect(view.container.innerHTML).toContain(">1 KB</span>");
    expect(view.container.innerHTML).not.toContain('aria-label="Download notes.txt"');
    expect(view.container.innerHTML).toContain("legacy.txt");
    expect(view.container.innerHTML).not.toContain('href="t3-context://');
    // A picture keeps its tile even though it also has a chip: the chip names it, the tile is
    // the only way to see it. A plain file's row is what a chip replaces.
    expect(view.container.innerHTML).toContain("grid-cols-2");
  });

  it("resolves an annotation screenshot through its image context record", () => {
    const image = {
      type: "image" as const,
      id: "thread-1-screenshot",
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const annotation = {
      version: 1 as const,
      contextId: "annotation-1" as never,
      kind: "preview-annotation" as const,
      label: "Checkout button",
      annotationId: "producer-id",
      pageUrl: "https://example.test/checkout",
      pageTitle: "Checkout",
      comment: "This changed after clicking",
      targetSummary: "1 selected element",
      styleChanges: [],
      screenshotContextId: "screenshot-1" as never,
    };
    const screenshotRecord = {
      version: 1 as const,
      contextId: "screenshot-1" as never,
      kind: "image" as const,
      label: "capture.png",
      attachmentId: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    };

    expect(
      resolvePreviewAnnotationImage({
        record: annotation,
        recordsById: new Map<string, ComposerContextRecord>([
          [annotation.contextId, annotation],
          [screenshotRecord.contextId, screenshotRecord],
        ]),
        userImages: [image],
        previewImages: [],
        annotationRecordIds: [annotation.contextId],
      }),
    ).toBe(image);
  });

  it("returns no annotation screenshot when its binding cannot be resolved", () => {
    expect(
      resolvePreviewAnnotationImage({
        record: {
          version: 1,
          contextId: "annotation-1" as never,
          kind: "preview-annotation",
          label: "Google",
          annotationId: "producer-id",
          pageUrl: "https://google.com",
          pageTitle: "Google",
          comment: "What is this?",
          targetSummary: "8 drawings",
          styleChanges: [],
          screenshotContextId: "missing-image" as never,
        },
        recordsById: new Map(),
        userImages: [],
        previewImages: [],
        annotationRecordIds: ["annotation-1"],
      }),
    ).toBeNull();
  });

  it("renders structured context records as chips without reparsing text", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-structured",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-structured"),
              role: "user",
              text: "Compare [Terminal 1 line 4](t3-context://v1/terminal/ctx-t) with [gone](t3-context://v1/future/ctx-x).",
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    contextId: "ctx-t" as never,
                    kind: "terminal",
                    label: "Terminal 1 line 4",
                    terminalId: "default",
                    terminalLabel: "Terminal 1",
                    lineStart: 4,
                    lineEnd: 4,
                    text: "boom",
                  },
                ],
              },
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(view.container.innerHTML).toContain("lucide-terminal");
    expect(view.container.innerHTML).toContain("Terminal 1 line 4");
    expect(view.container.innerHTML).toContain('data-context-unresolved="true"');
    expect(view.container.innerHTML).toContain(">gone<");
    expect(view.container.innerHTML).not.toContain('href="t3-context://');
  });

  it("keeps failed lifecycle entries discoverable in mixed activity summaries", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
            },
          },
        ]}
      />,
    );

    expect(
      view.find('[aria-label="Received 1 update and used 1 tool, tool call failed"]'),
    ).not.toBeNull();
    // Ordinary tool failures do not use destructive row styling.
    expect(view.find(".text-destructive")).toBeNull();
  });

  it("keeps the red treatment for severe orchestration failures", async () => {
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-turn-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-turn-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Provider turn start failed",
              tone: "error",
              sourceActivityKind: "provider.turn.start.failed",
            },
          },
        ]}
      />,
    );

    expect(view.find(".lucide-circle-alert")).not.toBeNull();
    expect(view.find(".text-destructive")).not.toBeNull();
  });
});

describe("work log coalescing (rendered)", () => {
  // `tone: "info"` because the tone union is info/tool/approval/error — there is
  // no "warn". Inlined shape (no helper indirection) so the literals are
  // contextually typed by the prop, matching the rest of this file.
  const warning = (n: string) => ({
    id: `entry-${n}`,
    kind: "work" as const,
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id: `work-${n}`,
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Runtime warning",
      tone: "info" as const,
    },
  });

  it("collapses a burst behind the group toggle before coalescing is visible", async () => {
    // A burst first collapses into a tool group whose toggle summarises it ("Received 3
    // updates"), so the individual rows are not rendered until it is expanded. Expanding it
    // does not produce a coalesced xN badge either — see the interaction test below. The
    // count arithmetic is covered in MessagesTimeline.logic.test.ts.
    //
    // Upstream #8734 replaced the old "+N previous log entries" control with this grouping,
    // so the label moved -- the boundary this test documents did not.
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[warning("1"), warning("2"), warning("3")]}
      />,
    );
    expect(view.text()).toContain("Received 3 updates");
    expect(view.text().split("Runtime warning").length - 1).toBeLessThan(3);
  });

  it("shows no count for a single occurrence", async () => {
    const view = await renderDom(
      <MessagesTimeline {...buildProps()} timelineEntries={[warning("1")]} />,
    );
    expect(view.text()).toContain("Runtime warning");
    expect(view.text()).not.toContain("×1");
  });
});

// These are the tests a static render could not reach: every one of them needs an event.
describe("MessagesTimeline interactions", () => {
  it("reveals the hidden tail of a long user message when it is expanded", async () => {
    const tail = "deep hidden detail only after expand";
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText(tail))]}
      />,
    );

    const toggle = () =>
      view
        .findAll("button")
        .find(
          (button) =>
            button.textContent === "Show full message" || button.textContent === "Show less",
        ) ?? null;

    expect(view.find('[data-user-message-collapsed="true"]')).not.toBeNull();

    await view.click(toggle());

    expect(view.find('[data-user-message-collapsed="true"]')).toBeNull();
    expect(view.text()).toContain(tail);
    expect(view.text()).toContain("Show less");

    // The way back out: a one-way expand would be a one-way door.
    await view.click(toggle());

    expect(view.find('[data-user-message-collapsed="true"]')).not.toBeNull();
    expect(view.text()).toContain("Show full message");
  });

  it("asks for an earlier page when the load-earlier control is pressed", async () => {
    const onLoadEarlier = vi.fn();
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Hello")]}
        loadEarlier={{ loading: false, onLoadEarlier }}
      />,
    );

    const control = view
      .findAll("button")
      .find((button) => button.textContent?.includes("Load earlier turns"));
    await view.click(control ?? null);

    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a second page while one is already in flight", async () => {
    // The paired half of "disables the load-earlier control while a page is in flight":
    // a disabled control that still fires would double-fetch on every impatient click.
    const onLoadEarlier = vi.fn();
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Hello")]}
        loadEarlier={{ loading: true, onLoadEarlier }}
      />,
    );

    const control = view
      .findAll("button")
      .find((button) => button.textContent?.includes("Loading earlier turns"));
    await view.click(control ?? null);

    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("expands the burst into its individual rows rather than a coalesced count", async () => {
    // Measured here, now that expansion is reachable: expanding the group does NOT produce
    // the coalesced ×N badge. `ExpandedWorkGroupEntries` renders every entry with count 1;
    // the badge belongs to the ungrouped activity section, which runs the entries through
    // `coalesceRepeatedWorkLogEntries`. The static version of this file asserted the
    // opposite in a comment it had no way to check.
    const warning = (n: string) => ({
      id: `entry-${n}`,
      kind: "work" as const,
      createdAt: "2026-03-17T19:12:28.000Z",
      entry: {
        id: `work-${n}`,
        createdAt: "2026-03-17T19:12:28.000Z",
        label: "Runtime warning",
        tone: "info" as const,
      },
    });
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[warning("1"), warning("2"), warning("3")]}
      />,
    );

    expect(view.text()).not.toContain("×3");

    const groupToggle = view
      .findAll("button")
      .find((button) => button.textContent?.includes("Received 3 updates"));
    await view.click(groupToggle ?? null);

    expect(view.text().split("Runtime warning").length - 1).toBe(3);
    expect(view.text()).not.toContain("×3");
  });
});

// Ported from upstream's MessagesTimeline.test.tsx, which this fork renamed to a real-DOM
// suite (docs/fork/README.md invariant 36) - so upstream's additions arrive as a
// delete/modify rather than a conflict and are easy to drop. Upstream asserts on
// renderToStaticMarkup strings; AGENTS.md rules that out, so these drive the mounted tree.
function buildSnapShotTimelineEntry(previewUrl?: string) {
  const entry = buildUserTimelineEntry("First prompt.");
  return {
    ...entry,
    message: {
      ...entry.message,
      attachments: [
        {
          type: "image" as const,
          id: "attachment-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1,
          ...(previewUrl ? { previewUrl } : {}),
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-03-17T19:12:28.000Z",
            appName: "Terminal",
            windowTitle: "t3code — Tests",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    },
  };
}

describe("MessagesTimeline snap shots and turn navigation", () => {
  it("renders previous and next controls with the minimap", async () => {
    const first = buildUserTimelineEntry("First turn");
    const secondBase = buildUserTimelineEntry("Second turn");
    const second = {
      ...secondBase,
      id: "entry-2",
      message: { ...secondBase.message, id: MessageId.make("message-2") },
    };
    const view = await renderDom(
      <MessagesTimeline {...buildProps()} timelineEntries={[first, second]} />,
    );

    expect(view.find('[aria-label="Previous turn"]')).not.toBeNull();
    expect(view.find('[aria-label="Next turn"]')).not.toBeNull();
  });

  it("anchors the first user message using its measured height", async () => {
    const onAnchorReady = vi.fn();
    const firstEntry = buildSnapShotTimelineEntry("data:image/png;base64,iVBORw0KGgo=");
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={firstEntry.message.id}
        onAnchorReady={onAnchorReady}
        contentInsetEndAdjustment={144}
        timelineEntries={[firstEntry]}
      />,
    );

    expect(view.find('[data-anchor-index="0"]')).not.toBeNull();
    expect(view.find('[data-anchor-offset="24"]')).not.toBeNull();
    expect(view.find("[data-anchor-max-size]")).toBeNull();
    expect(view.find('[data-content-inset-end="144"]')).not.toBeNull();
    expect(attributeValues(view).some((value) => value.includes("[overflow-anchor:none]"))).toBe(
      true,
    );
    // A pinned anchor is the opposite of following the end: both at once would fight.
    expect(view.find(MAINTAIN_SCROLL_AT_END)).toBeNull();
    expect(view.find('[data-maintain-visible-content-position="object"]')).not.toBeNull();
    expect(view.find('[data-maintain-visible-content-position-data="true"]')).not.toBeNull();
    expect(view.find('[data-maintain-visible-content-position-size="true"]')).not.toBeNull();
    expect(view.find('[data-maintain-visible-content-position-restore="true"]')).not.toBeNull();
    expect(view.text()).toContain("Terminal");
    expect(view.text()).toContain("t3code — Tests");
    expect(view.find('img[src="data:image/png;base64,aWNvbg=="]')).not.toBeNull();
    expect(attributeValues(view).some((value) => value.includes("h-28 w-52 max-w-full"))).toBe(
      true,
    );
    // Upstream now gives a resolved snap-shot its own full-width frame
    // (`SNAP_SHOT_ATTACHMENT_FRAME_CLASS` + `col-span-2`), so the old
    // "never spans two columns" assertion described the previous layout.
    // Upstream asserts a single call, which only holds for its one-pass static render. A real
    // mount measures and re-renders, so the list reports the anchor again; what matters is that
    // every report names the same anchor, not how many passes it took.
    expect(onAnchorReady).toHaveBeenCalledWith(firstEntry.message.id, 0);
    expect(
      onAnchorReady.mock.calls.every(
        ([messageId, anchorIndex]) => messageId === firstEntry.message.id && anchorIndex === 0,
      ),
    ).toBe(true);
  });

  it("does not render window details before the preview URL resolves", async () => {
    const view = await renderDom(
      <MessagesTimeline {...buildProps()} timelineEntries={[buildSnapShotTimelineEntry()]} />,
    );

    expect(view.text()).toContain("screenshot.png");
    expect(view.text()).not.toContain("Terminal");
    expect(view.text()).not.toContain("t3code — Tests");
    expect(view.find('img[src="data:image/png;base64,aWNvbg=="]')).toBeNull();
    expect(attributeValues(view).some((value) => value.includes("h-28 w-52 max-w-full"))).toBe(
      false,
    );
  });

  it("does not reserve end space for a follow-up user message", async () => {
    const onAnchorReady = vi.fn();
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondBase = buildUserTimelineEntry("Newest prompt.");
    const secondEntry = {
      ...secondBase,
      id: "entry-2",
      message: { ...secondBase.message, id: MessageId.make("message-2") },
    };
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={secondEntry.message.id}
        onAnchorReady={onAnchorReady}
        timelineEntries={[firstEntry, secondEntry]}
      />,
    );

    expect(view.find("[data-anchor-index]")).toBeNull();
    expect(view.find(MAINTAIN_SCROLL_AT_END)).not.toBeNull();
    expect(onAnchorReady).not.toHaveBeenCalled();
  });

  // The answer history lives in the row's expanded body, so the row has to be opened first.
  // Upstream drives that through `react-test-renderer`, deprecated in React 19 and the reason
  // its own copy of this test carries a "migrate when a DOM setup exists" note; this is that
  // setup, so the toggle is clicked as a real control.
  it.each([{}, { text: "Text-only answer", file: "Answer with a file" }])(
    "renders question answer history with its attachments: %j",
    async (answers) => {
      const view = await renderDom(
        <MessagesTimeline
          {...buildProps()}
          timelineEntries={[
            {
              id: "answer-entry",
              kind: "work" as const,
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: "answer-work",
                createdAt: MESSAGE_CREATED_AT,
                label: "Question answer submitted",
                tone: "info" as const,
                questionAnswer: {
                  requestId: ApprovalRequestId.make("question-request"),
                  answers,
                  questionTextById: { file: "Provide a spec", image: "Provide a screenshot" },
                  attachmentsByQuestionId: {
                    file: [
                      {
                        type: "file" as const,
                        id: "spec",
                        name: "spec.txt",
                        mimeType: "text/plain",
                        sizeBytes: 4,
                      },
                    ],
                    image: [
                      {
                        type: "image" as const,
                        id: "shot",
                        name: "shot.png",
                        mimeType: "image/png",
                        sizeBytes: 4,
                      },
                    ],
                  },
                },
              },
            },
          ]}
        />,
      );

      await view.click(view.find('[aria-expanded="false"]'));

      const text = view.text();
      // Each question is named once, not once per attachment and once per answer.
      expect(text.match(/Provide a spec/g)).toHaveLength(1);
      expect(text.match(/spec\.txt/g)).toHaveLength(1);
      expect(text).toContain("Provide a screenshot");
      expect(text).toContain("shot.png");
      for (const answer of Object.values(answers)) expect(text).toContain(answer);
    },
  );
});

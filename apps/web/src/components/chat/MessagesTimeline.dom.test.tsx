import { CheckpointRef, EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { codexFeedbackMessage } from "@t3tools/client-runtime/state/threads";
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

// The DOM this file needs is the real one now: it runs under the `dom` project, so the
// stub `window`/`document`/`Element` this suite used to install for the `node` environment
// would replace a working DOM with a broken one.
//
// No per-hook timeout here on purpose. The `dom` project sets hookTimeout to 120s
// precisely because these imports are heavy, and a local override could only lower
// it. This import measures ~3.5s idle but exceeded a 30s cap twice during full-gate
// runs on 2026-09-07, failing the suite at import with zero tests failing.
beforeAll(async () => {
  ({ MessagesTimeline } = await import("./MessagesTimeline"));
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
  it("renders a feedback command and its pending response as normal thread messages", async () => {
    const submission = {
      id: MessageId.make("feedback-command"),
      command: "/feedback The agent stopped early.",
      createdAt: MESSAGE_CREATED_AT,
      status: "uploading" as const,
    };
    const messages = [
      codexFeedbackMessage(submission),
      codexFeedbackMessage(submission, "assistant"),
    ];
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={messages.map((message) => ({
          id: message.id,
          kind: "message" as const,
          createdAt: message.createdAt,
          message,
        }))}
      />,
    );

    expect(view.text()).toContain("/feedback The agent stopped early.");
    expect(view.text()).toContain("Sending feedback to OpenAI...");
  });

  it("renders the returned Codex thread ID in the feedback response", async () => {
    const submission = {
      id: MessageId.make("feedback-command"),
      command: "/feedback The agent stopped early.",
      createdAt: MESSAGE_CREATED_AT,
      status: "sent" as const,
      feedbackId: "codex-thread-1",
    };
    const messages = [
      codexFeedbackMessage(submission),
      codexFeedbackMessage(submission, "assistant"),
    ];
    const view = await renderDom(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={messages.map((message) => ({
          id: message.id,
          kind: "message" as const,
          createdAt: message.createdAt,
          message,
        }))}
      />,
    );

    expect(view.text()).toContain("Feedback sent to OpenAI.");
    expect(view.text()).toContain("codex-thread-1");
  });

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
    expect(download?.className).toBe(
      "flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
    );
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

    expect(view.text()).toContain("Terminal 1 lines 1-5");
    expect(view.find(".lucide-terminal")).not.toBeNull();
    // The prompt's own trailing paragraph, followed by the chip's spacing span.
    expect(view.findAll("p").some((element) => element.textContent?.endsWith("yoo what's"))).toBe(
      true,
    );
    expect(
      view.findAll('span[aria-hidden="true"]').some((element) => element.textContent === " "),
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

    expect(view.text()).toContain("contextWindow.test.ts");
    expect(view.text()).toContain("Wadduo");
    expect(view.find('[data-testid="file-diff"]')).not.toBeNull();
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

    expect(view.text()).toContain("plan.md");
    expect(view.text()).toContain("Clarify this.");
    expect(view.text()).toContain("# Plan");
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

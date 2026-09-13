import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { composeTurnStart, type ComposeTurnStartInput } from "./composeTurnStart";

const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");

function input(overrides: Partial<ComposeTurnStartInput> = {}): ComposeTurnStartInput {
  return {
    prompt: "  fix the build  ",
    trimmedPrompt: "fix the build",
    images: [],
    files: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    provider: ProviderDriverKind.make("codex"),
    model: "gpt-5.5",
    models: [],
    effort: null,
    modelSelection,
    projectDefaultModel: null,
    project: { id: ProjectId.make("project-1"), workspaceRoot: "/repo" },
    thread: { createdAt: "2026-09-13T10:00:00.000Z", worktreePath: null },
    isLocalDraftThread: false,
    isFirstMessage: false,
    sendEnvMode: "local",
    branch: "main",
    startFromOrigin: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    randomHex: () => "abcd",
    ...overrides,
  };
}

const image = {
  type: "image",
  id: "img-1",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 10,
  previewUrl: "blob:1",
  file: new File([], "screen.png"),
} as ComposerImageAttachment;

describe("composeTurnStart", () => {
  it("a follow-up on a started thread sends the trimmed text with no bootstrap", () => {
    const result = composeTurnStart(input());
    expect(result).toEqual({
      outgoingMessageText: "fix the build",
      title: "fix the build",
      missingWorktreeBaseBranch: false,
      baseBranchForWorktree: null,
      bootstrap: undefined,
    });
  });

  it("a local draft creates its thread with the draft's settings", () => {
    const result = composeTurnStart(
      input({
        isLocalDraftThread: true,
        isFirstMessage: true,
        model: null,
        projectDefaultModel: "gpt-5.4",
      }),
    );
    expect(result.bootstrap).toEqual({
      createThread: {
        projectId: "project-1",
        title: "fix the build",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4"),
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: "2026-09-13T10:00:00.000Z",
      },
    });
  });

  it("a draft's own model pick outranks the project default", () => {
    const result = composeTurnStart(
      input({ isLocalDraftThread: true, isFirstMessage: true, projectDefaultModel: "gpt-5.4" }),
    );
    expect(result.bootstrap?.createThread?.modelSelection).toEqual(modelSelection);
  });

  it("a later message in worktree mode prepares nothing", () => {
    const result = composeTurnStart(input({ sendEnvMode: "worktree" }));
    expect(result.baseBranchForWorktree).toBeNull();
    expect(result.bootstrap).toBeUndefined();
  });

  it("a first message in worktree mode prepares a worktree from the chosen branch", () => {
    const result = composeTurnStart(
      input({ isFirstMessage: true, sendEnvMode: "worktree", startFromOrigin: true }),
    );
    expect(result.baseBranchForWorktree).toBe("main");
    expect(result.bootstrap).toEqual({
      prepareWorktree: {
        projectCwd: "/repo",
        baseBranch: "main",
        branch: expect.stringContaining("abcd"),
        startFromOrigin: true,
      },
      runSetupScript: true,
    });
  });

  it("worktree mode without a base branch is flagged, and an existing worktree needs none", () => {
    expect(
      composeTurnStart(input({ isFirstMessage: true, sendEnvMode: "worktree", branch: null }))
        .missingWorktreeBaseBranch,
    ).toBe(true);
    const existing = composeTurnStart(
      input({
        isFirstMessage: true,
        sendEnvMode: "worktree",
        branch: null,
        thread: { createdAt: "2026-09-13T10:00:00.000Z", worktreePath: "/wt" },
      }),
    );
    expect(existing.missingWorktreeBaseBranch).toBe(false);
    expect(existing.bootstrap).toBeUndefined();
  });

  it("an attachment-only send gets the bootstrap prompt and an image title", () => {
    const result = composeTurnStart(input({ prompt: "", trimmedPrompt: "", images: [image] }));
    expect(result.title).toBe("Image: screen.png");
    expect(result.outgoingMessageText.length).toBeGreaterThan(0);
  });

  it("terminal context is appended to the text and titles a text-less send", () => {
    const context = {
      id: "ctx-1",
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-09-13T10:00:00.000Z",
      terminalId: "term-1",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "npm ERR! boom",
    };
    const withText = composeTurnStart(input({ terminalContexts: [context] }));
    expect(withText.outgoingMessageText.startsWith("fix the build\n\n")).toBe(true);
    expect(withText.outgoingMessageText).toContain("npm ERR! boom");
    const textless = composeTurnStart(
      input({ prompt: "", trimmedPrompt: "", terminalContexts: [context] }),
    );
    expect(textless.title).toBe("Terminal 1 lines 3-4");
  });
});

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import { useMarkdownViewerStore } from "./markdownViewerStore";

const ENV = "env-1" as EnvironmentId;

describe("markdownViewerStore", () => {
  afterEach(() => {
    useMarkdownViewerStore.setState({ open: false, request: null });
  });

  it("opens with the requested path and a fresh requestId", () => {
    useMarkdownViewerStore.getState().openMarkdownViewer({
      path: "~/reports/x.md",
      cwd: "/repo",
      environmentId: ENV,
    });

    const state = useMarkdownViewerStore.getState();
    expect(state.open).toBe(true);
    expect(state.request?.path).toBe("~/reports/x.md");
    expect(state.request?.cwd).toBe("/repo");
    expect(state.request?.environmentId).toBe(ENV);
    expect(state.request?.requestId).toBe(1);
  });

  it("bumps requestId when re-opening the same path so reads re-trigger", () => {
    const { openMarkdownViewer } = useMarkdownViewerStore.getState();
    openMarkdownViewer({ path: "a.md", cwd: undefined, environmentId: ENV });
    openMarkdownViewer({ path: "a.md", cwd: undefined, environmentId: ENV });

    expect(useMarkdownViewerStore.getState().request?.requestId).toBe(2);
  });

  it("closes without dropping the last request", () => {
    const { openMarkdownViewer, closeMarkdownViewer } = useMarkdownViewerStore.getState();
    openMarkdownViewer({ path: "a.md", cwd: undefined, environmentId: ENV });
    closeMarkdownViewer();

    const state = useMarkdownViewerStore.getState();
    expect(state.open).toBe(false);
    expect(state.request?.path).toBe("a.md");
  });
});

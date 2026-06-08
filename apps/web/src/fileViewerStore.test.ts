import { afterEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import { useFileViewerStore } from "./fileViewerStore";

const ENV = "env-1" as EnvironmentId;

describe("fileViewerStore", () => {
  afterEach(() => {
    useFileViewerStore.setState({ open: false, request: null });
  });

  it("opens with the requested path, kind, and a fresh requestId", () => {
    useFileViewerStore.getState().openFileViewer({
      path: "~/reports/x.md",
      cwd: "/repo",
      environmentId: ENV,
      kind: "markdown",
    });

    const state = useFileViewerStore.getState();
    expect(state.open).toBe(true);
    expect(state.request?.path).toBe("~/reports/x.md");
    expect(state.request?.cwd).toBe("/repo");
    expect(state.request?.environmentId).toBe(ENV);
    expect(state.request?.kind).toBe("markdown");
    expect(state.request?.requestId).toBe(1);
  });

  it("bumps requestId when re-opening the same path so reads re-trigger", () => {
    const { openFileViewer } = useFileViewerStore.getState();
    openFileViewer({ path: "a.html", cwd: undefined, environmentId: ENV, kind: "html" });
    openFileViewer({ path: "a.html", cwd: undefined, environmentId: ENV, kind: "html" });

    expect(useFileViewerStore.getState().request?.requestId).toBe(2);
  });

  it("closes without dropping the last request", () => {
    const { openFileViewer, closeFileViewer } = useFileViewerStore.getState();
    openFileViewer({ path: "a.md", cwd: undefined, environmentId: ENV, kind: "markdown" });
    closeFileViewer();

    const state = useFileViewerStore.getState();
    expect(state.open).toBe(false);
    expect(state.request?.path).toBe("a.md");
  });
});

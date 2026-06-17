import { create } from "zustand";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The source file's intrinsic type (from its extension): a markdown document, a
 * raw HTML document, or any other text/code file (`"code"`, rendered with syntax
 * highlighting).
 */
export type FileViewerKind = "html" | "markdown" | "code";

/**
 * How a markdown file is displayed: as in-app rendered markdown (`"markdown"`)
 * or as a backend-generated standalone HTML document (`"html"`). Ignored for
 * `kind === "html"` (always HTML) and `kind === "code"` (always the highlighted
 * source) files.
 */
export type FileViewerView = "markdown" | "html";

export interface FileViewerRequest {
  /** Raw path as displayed in the message (absolute, `~/…`, or cwd-relative). */
  path: string;
  /** Working directory used to resolve relative paths and `~` server-side. */
  cwd: string | undefined;
  /** Environment whose backend reads the file. */
  environmentId: EnvironmentId;
  /** How to render the file once read. */
  kind: FileViewerKind;
  /** Initial view mode for a markdown file (defaults to `"markdown"`). */
  view: FileViewerView;
  /** Monotonic id so re-opening the same path re-triggers a read. */
  requestId: number;
}

/** Args to open the viewer; `view` defaults to `"markdown"` when omitted. */
export type OpenFileViewerInput = Omit<FileViewerRequest, "requestId" | "view"> & {
  view?: FileViewerView;
};

interface FileViewerStore {
  open: boolean;
  request: FileViewerRequest | null;
  openFileViewer: (request: OpenFileViewerInput) => void;
  closeFileViewer: () => void;
}

export const useFileViewerStore = create<FileViewerStore>((set) => ({
  open: false,
  request: null,
  openFileViewer: (request) =>
    set((state) => ({
      open: true,
      request: {
        ...request,
        view: request.view ?? "markdown",
        requestId: (state.request?.requestId ?? 0) + 1,
      },
    })),
  closeFileViewer: () => set({ open: false }),
}));

import { create } from "zustand";
import type { EnvironmentId } from "@t3tools/contracts";

/** Which renderer the viewer sidebar uses for a file. */
export type FileViewerKind = "html" | "markdown";

export interface FileViewerRequest {
  /** Raw path as displayed in the message (absolute, `~/…`, or cwd-relative). */
  path: string;
  /** Working directory used to resolve relative paths and `~` server-side. */
  cwd: string | undefined;
  /** Environment whose backend reads the file. */
  environmentId: EnvironmentId;
  /** How to render the file once read. */
  kind: FileViewerKind;
  /** Monotonic id so re-opening the same path re-triggers a read. */
  requestId: number;
}

interface FileViewerStore {
  open: boolean;
  request: FileViewerRequest | null;
  openFileViewer: (request: Omit<FileViewerRequest, "requestId">) => void;
  closeFileViewer: () => void;
}

export const useFileViewerStore = create<FileViewerStore>((set) => ({
  open: false,
  request: null,
  openFileViewer: (request) =>
    set((state) => ({
      open: true,
      request: { ...request, requestId: (state.request?.requestId ?? 0) + 1 },
    })),
  closeFileViewer: () => set({ open: false }),
}));

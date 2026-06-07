import { create } from "zustand";
import type { EnvironmentId } from "@t3tools/contracts";

export interface MarkdownViewerRequest {
  /** Raw path as displayed in the message (absolute, `~/…`, or cwd-relative). */
  path: string;
  /** Working directory used to resolve relative paths and `~` server-side. */
  cwd: string | undefined;
  /** Environment whose backend reads the file. */
  environmentId: EnvironmentId;
  /** Monotonic id so re-opening the same path re-triggers a read. */
  requestId: number;
}

interface MarkdownViewerStore {
  open: boolean;
  request: MarkdownViewerRequest | null;
  openMarkdownViewer: (request: Omit<MarkdownViewerRequest, "requestId">) => void;
  closeMarkdownViewer: () => void;
}

export const useMarkdownViewerStore = create<MarkdownViewerStore>((set) => ({
  open: false,
  request: null,
  openMarkdownViewer: (request) =>
    set((state) => ({
      open: true,
      request: { ...request, requestId: (state.request?.requestId ?? 0) + 1 },
    })),
  closeMarkdownViewer: () => set({ open: false }),
}));

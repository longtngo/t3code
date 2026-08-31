import {
  VIDEO_CONTENT_TYPE_BY_EXTENSION,
  WORKSPACE_VIDEO_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import { describe, expect, it } from "vite-plus/test";

import { type ChatFileAttachment, isVideoAttachment, videoMimeType } from "./types";

// An empty mimeType forces the extension table to be the thing under test; a
// `video/*` mimeType short-circuits ahead of it.
const asAttachment = (name: string): ChatFileAttachment => ({
  type: "file",
  id: `attachment-${name}`,
  name,
  mimeType: "",
  sizeBytes: 0,
});

/**
 * Two tables name video extensions for two different jobs: this file's table
 * answers "is this attachment a video the composer should render", and the shared
 * one answers "what Content-Type does the viewer serve this file as". They are
 * deliberately NOT one table — the attachment set is a superset (`.avi`, `.mkv`)
 * of formats no browser can decode from a <video>, so merging either direction
 * breaks one of the two jobs.
 *
 * What must hold is that they never disagree where they overlap. Review already
 * caught them disagreeing once, on `.m4v`.
 */
describe("video extension tables", () => {
  it("agrees with the shared viewer table on every extension both name", () => {
    for (const extension of WORKSPACE_VIDEO_PREVIEW_EXTENSIONS) {
      expect(videoMimeType(asAttachment(`clip${extension}`))).toBe(
        VIDEO_CONTENT_TYPE_BY_EXTENSION[extension],
      );
    }
  });

  it("recognizes everything the viewer will play, so the sets cannot diverge", () => {
    for (const extension of WORKSPACE_VIDEO_PREVIEW_EXTENSIONS) {
      expect(isVideoAttachment(asAttachment(`clip${extension}`))).toBe(true);
    }
  });

  it("stays a superset, which is why the two are not one list", () => {
    // Real video an attachment can carry and a <video> cannot decode. The viewer
    // must keep refusing these, and the composer must keep accepting them.
    for (const name of ["clip.avi", "clip.mkv"]) {
      expect(isVideoAttachment(asAttachment(name))).toBe(true);
      expect(WORKSPACE_VIDEO_PREVIEW_EXTENSIONS.some((extension) => name.endsWith(extension))).toBe(
        false,
      );
    }
  });
});

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
 * Two video tables, two jobs: this one ("render as a composer video") is a superset (`.avi`,
 * `.mkv`) of the shared one ("which Content-Type the viewer serves"), so they must NOT merge. They
 * must only agree where they overlap; review once caught them disagreeing on `.m4v`.
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

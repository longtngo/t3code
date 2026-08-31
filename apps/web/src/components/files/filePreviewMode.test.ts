import { describe, expect, it } from "vite-plus/test";

import { rendersFromAssetUrl } from "./filePreviewMode";

describe("rendersFromAssetUrl", () => {
  // This gate decides whether the panel issues a text read at all. A byte kind
  // missing from it is not merely slower: the read comes back "is binary and
  // cannot be previewed as text", which is the exact error workspace video used
  // to show before it was added here.
  it("covers every kind served as raw bytes", () => {
    for (const path of ["shot.png", "logo.svg", "demo.mp4", "clip.mov", "talk.mp3", "song.flac"]) {
      expect(rendersFromAssetUrl(path)).toBe(true);
    }
  });

  it("leaves text and browser-preview kinds on the read path", () => {
    // A PDF and an HTML report are rendered by the browser preview, not from an
    // asset URL, and source files must still be read as text.
    for (const path of ["report.pdf", "report.html", "index.ts", "notes.md"]) {
      expect(rendersFromAssetUrl(path)).toBe(false);
    }
  });
});

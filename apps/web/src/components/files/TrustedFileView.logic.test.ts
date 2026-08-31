import { describe, expect, it } from "vite-plus/test";

import {
  directoryOfAbsolutePath,
  rawMediaOutcome,
  shouldProbeForDirectory,
  trustedViewKind,
} from "./TrustedFileView";

describe("trustedViewKind", () => {
  it("renders html as a document, which is what gives it a source toggle", () => {
    expect(trustedViewKind("/Users/me/report.html")).toBe("html");
    expect(trustedViewKind("/Users/me/report.HTM")).toBe("html");
  });

  it("classifies images, which are read as bytes rather than text", () => {
    expect(trustedViewKind("/Users/me/dashboard.png")).toBe("image");
    expect(trustedViewKind("/Users/me/logo.svg")).toBe("image");
  });

  it("classifies video, which streams from the byte route like an image", () => {
    expect(trustedViewKind("/Users/me/demo.mp4")).toBe("video");
    expect(trustedViewKind("/Users/me/clip.MOV")).toBe("video");
  });

  it("still falls back to code for media it cannot play", () => {
    // Admitting video must not turn the fallback into "render anything".
    expect(trustedViewKind("/Users/me/clip.avi")).toBe("code");
  });

  it("keeps .mdx as markdown, which the shared classifier alone would drop", () => {
    // classifyFileViewerKind covers only md|markdown; losing mdx here would demote
    // it from rendered markdown to source.
    expect(trustedViewKind("/Users/me/notes.mdx")).toBe("markdown");
    expect(trustedViewKind("/Users/me/notes.md")).toBe("markdown");
  });

  it("falls back to code for anything unclassified, so the address bar still works", () => {
    // A null classification means "do not make this a chip", NOT "unviewable".
    expect(trustedViewKind("/Users/me/Makefile")).toBe("code");
    expect(trustedViewKind("/Users/me/Dockerfile")).toBe("code");
    expect(trustedViewKind("/Users/me/.env")).toBe("code");
    expect(trustedViewKind("/Users/me/data.weirdext")).toBe("code");
    expect(trustedViewKind("/Users/me/main.ts")).toBe("code");
  });
});

describe("directoryOfAbsolutePath", () => {
  it("returns the parent directory, which markdown relative links resolve against", () => {
    expect(directoryOfAbsolutePath("/Users/me/reports/a.md")).toBe("/Users/me/reports");
  });

  it("keeps root as root rather than collapsing to an empty cwd", () => {
    expect(directoryOfAbsolutePath("/a.md")).toBe("/");
  });
});

describe("rawMediaOutcome", () => {
  const base = {
    hasUrl: true,
    mediaFailed: false,
    listingHasData: false,
    listingIsPending: false,
  };

  it("waits for the environment URL before deciding anything", () => {
    expect(rawMediaOutcome({ ...base, hasUrl: false })).toBe("connecting");
    // Even a failure cannot be trusted before there is a URL to have failed.
    expect(rawMediaOutcome({ ...base, hasUrl: false, mediaFailed: true })).toBe("connecting");
  });

  it("shows the media until it reports a failure", () => {
    expect(rawMediaOutcome(base)).toBe("media");
    // A listing arriving for some other reason must not displace working media.
    expect(rawMediaOutcome({ ...base, listingHasData: true })).toBe("media");
  });

  it("shows the folder when a failed media path turns out to be a directory", () => {
    // The whole point: a DIRECTORY named `demo.mp4` fails as a <video> and
    // succeeds as a listing. Before this, it was a dead player forever.
    expect(rawMediaOutcome({ ...base, mediaFailed: true, listingHasData: true })).toBe("listing");
  });

  it("probes before giving up, then reports the failure it started with", () => {
    expect(rawMediaOutcome({ ...base, mediaFailed: true, listingIsPending: true })).toBe("probing");
    // Probe finished with nothing: this really was an unplayable file, so the
    // media error stands rather than being replaced by a directory error.
    expect(rawMediaOutcome({ ...base, mediaFailed: true })).toBe("failed");
  });
});

describe("shouldProbeForDirectory", () => {
  it("probes on a failed text read, as it always has", () => {
    expect(shouldProbeForDirectory({ readError: "Failed to read", mediaFailed: false })).toBe(true);
  });

  it("probes on a failed media element, which is a raw-byte kind's only signal", () => {
    // The regression this guards: a raw-byte kind never issues the text read, so
    // `readError` stays null forever and arming on it alone left a DIRECTORY named
    // `demo.mp4` showing a dead player instead of its contents.
    expect(shouldProbeForDirectory({ readError: null, mediaFailed: true })).toBe(true);
  });

  it("does not probe while nothing has failed", () => {
    expect(shouldProbeForDirectory({ readError: null, mediaFailed: false })).toBe(false);
  });
});

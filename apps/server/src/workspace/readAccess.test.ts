// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { allowedReadRoots, isWithinAllowedRoots } from "./readAccess.ts";

// POSIX-style fixtures; the suite runs on darwin/linux where `path.sep` is "/".
const home = "/home/alice";
const tmp = "/var/folders/T";
const project = "/opt/work/proj";
const roots = [home, tmp, project];

describe("isWithinAllowedRoots", () => {
  it("accepts a root itself", () => {
    expect(isWithinAllowedRoots(home, roots)).toBe(true);
    expect(isWithinAllowedRoots(tmp, roots)).toBe(true);
  });

  it("accepts descendants of any root", () => {
    expect(isWithinAllowedRoots(`${home}/reports/a.md`, roots)).toBe(true);
    expect(isWithinAllowedRoots(`${tmp}/handoff.md`, roots)).toBe(true);
    expect(isWithinAllowedRoots(`${project}/src/x.md`, roots)).toBe(true);
  });

  it("rejects paths outside every root", () => {
    expect(isWithinAllowedRoots("/etc/passwd", roots)).toBe(false);
    expect(isWithinAllowedRoots("/opt/other/secret.md", roots)).toBe(false);
  });

  it("rejects a sibling that shares a name prefix", () => {
    expect(isWithinAllowedRoots("/home/alice-evil/secret.md", roots)).toBe(false);
  });

  it("rejects `..` traversal that escapes a root", () => {
    expect(isWithinAllowedRoots(`${home}/../bob/secret.md`, roots)).toBe(false);
  });

  it("normalizes `..` that stays within a root", () => {
    expect(isWithinAllowedRoots(`${home}/a/../reports/b.md`, roots)).toBe(true);
  });
});

describe("allowedReadRoots", () => {
  it("always includes home and the OS temp dir", () => {
    const result = allowedReadRoots();
    expect(result).toContain(NodePath.resolve(NodeOS.homedir()));
    expect(result).toContain(NodePath.resolve(NodeOS.tmpdir()));
  });

  it("appends absolute server-trusted roots", () => {
    const result = allowedReadRoots(["/opt/work/proj"]);
    expect(result).toContain("/opt/work/proj");
  });

  it("ignores relative trusted roots so a bogus value can't widen the sandbox", () => {
    expect(allowedReadRoots([".", "relative/dir", ""])).toEqual(allowedReadRoots());
  });

  it("a trusted project root does not widen the sandbox to unrelated paths", () => {
    // Only the passed project root (and home/tmp) become roots; siblings like
    // /etc stay out. Authorization safety relies on the handlers passing only
    // server-known project roots here, never the client cwd.
    const result = allowedReadRoots(["/opt/work/proj"]);
    expect(result).not.toContain(NodePath.resolve("/etc"));
  });
});

// @effect-diagnostics nodeBuiltinImport:off - the invariant is about which files
// reference which, so the test has to read them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * Phase 1 shipped `CrewToolkitLayer` and `CrewSweepLive` with **no importer
 * anywhere** (crew "mounted 1 of 3 surfaces"). Both typechecked, both had passing unit tests, and neither ran:
 * the five MCP tools were advertised to nobody and no crewmate report was ever
 * delivered. Only the panel's read path was mounted, which is exactly the third
 * that got verified end to end.
 *
 * A unit test cannot catch that — it provides the layer itself, so it passes
 * whether or not production composes it. This asserts the composition instead.
 */
const SERVER_SRC = NodePath.join(import.meta.dirname, "..");

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full;
  }
}

const importersOf = (symbol: string, definedIn: string): ReadonlyArray<string> =>
  Array.from(sourceFiles(SERVER_SRC))
    .filter((file) => !file.includes(NodePath.join("src", definedIn)))
    .filter((file) => new RegExp(`\\b${symbol}\\b`).test(NodeFS.readFileSync(file, "utf8")))
    .map((file) => NodePath.relative(SERVER_SRC, file));

describe("crew is actually composed into the server", () => {
  it.each([
    ["CrewToolkitLayer", "mcp/toolkits/crew"],
    ["CrewToolkitRegistrationLive", "mcp/toolkits/crew"],
    ["CrewLayerLive", "crew"],
  ])("%s is referenced outside its own module", (symbol, definedIn) => {
    expect(importersOf(symbol, definedIn)).not.toEqual([]);
  });

  it("the crew layer composes the sweep, the panel read and the MCP service", () => {
    const crewLayer = NodeFS.readFileSync(NodePath.join(SERVER_SRC, "crew/CrewLayer.ts"), "utf8");
    for (const symbol of ["CrewSweepLive", "CrewDirectoryLive", "CrewServiceLive("]) {
      expect(crewLayer).toContain(symbol);
    }
  });

  it("the MCP server mounts the crew toolkit registration", () => {
    const mcp = NodeFS.readFileSync(NodePath.join(SERVER_SRC, "mcp/McpHttpServer.ts"), "utf8");
    const mounted = mcp.slice(mcp.indexOf("export const layer = Layer.mergeAll("));
    expect(mounted).toContain("CrewToolkitRegistrationLive");
  });

  it("the sweep is started, not merely constructed", () => {
    const startup = NodeFS.readFileSync(
      NodePath.join(SERVER_SRC, "serverRuntimeStartup.ts"),
      "utf8",
    );
    // Building the layer costs nothing and delivers nothing; only start() forks the
    // orphan reap and the delivery loop.
    expect(startup).toContain("crewSweep.start()");
  });
});

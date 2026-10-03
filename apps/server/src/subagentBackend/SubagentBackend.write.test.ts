// @effect-diagnostics nodeBuiltinImport:off - builds a real tmpdir HOME so the fixed on-disk flag-file path is exercised for real.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  parsePersistedBackend,
  writeBackendFile,
  subagentBackendFilePath,
} from "./SubagentBackend.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sbt-write-"));
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
});

const CURSOR = {
  schemaVersion: 1,
  backend: "cursor",
  instanceId: "cursor",
  model: "auto",
  binaryPath: "/tmp/agent",
  apiEndpoint: "",
  updatedAt: null,
  degraded: null,
};

it.layer(NodeServices.layer)("writeBackendFile", (it) => {
  it.effect("writes 0600 and round-trips through the parser", () =>
    Effect.gen(function* () {
      yield* writeBackendFile(CURSOR);
      const filePath = yield* subagentBackendFilePath();

      expect(NodeFS.statSync(filePath).mode & 0o777).toBe(0o600);

      const parsed = parsePersistedBackend(NodeFS.readFileSync(filePath, "utf8"));
      expect(parsed.backend).toBe("cursor");
      expect(parsed.binaryPath).toBe("/tmp/agent");
      expect(parsed.model).toBe("auto");
      expect(parsed.updatedAt).not.toBeNull();
    }),
  );
});

// `it.layer`'s scoped `it` only exposes `.effect` (the virtual TestClock), not
// `.live`. This test needs real wall-clock delays to observe overlap, so it runs
// as a top-level `it.live` with the platform layer provided explicitly instead.
it.live(
  "orders concurrent writes through backendWriteSemaphore rather than letting them overlap",
  () =>
    Effect.gen(function* () {
      // `writeFileStringAtomically` already makes a single write tear-free (covered
      // by atomicWrite.test.ts), so racing writes without instrumentation would pass
      // whether or not the semaphore exists and would prove nothing about ordering.
      // Instead, delay inside a recorded `writeFileString` and assert no two writes
      // are ever in flight at once - the semaphore's actual job.
      const events: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;

      const fs = yield* FileSystem.FileSystem;
      const recording = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (file: string, data: string) =>
          Effect.gen(function* () {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            events.push(`start:${file}`);
            yield* Effect.sleep(10);
            const result = yield* fs.writeFileString(file, data);
            inFlight--;
            events.push(`end:${file}`);
            return result;
          }),
      });

      yield* Effect.all(
        Array.from({ length: 5 }, (_, index) =>
          writeBackendFile(index % 2 === 0 ? CURSOR : { ...CURSOR, backend: "default" }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(FileSystem.FileSystem, recording));

      expect(maxInFlight).toBe(1);
      // Each write's own writeFileString call must fully start-then-end before the
      // next one's start appears - a torn interleaving (start, start, end, end)
      // would mean two writes were in flight together.
      expect(events.length).toBe(10);
      for (let index = 0; index < events.length; index += 2) {
        expect(events[index]).toMatch(/^start:/);
        expect(events[index + 1]).toMatch(/^end:/);
      }

      const filePath = yield* subagentBackendFilePath();
      const parsed = parsePersistedBackend(NodeFS.readFileSync(filePath, "utf8"));
      expect(parsed.degraded).toBeNull();
      expect(["cursor", "default"]).toContain(parsed.backend);
    }).pipe(Effect.provide(NodeServices.layer)),
);

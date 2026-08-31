// @effect-diagnostics nodeBuiltinImport:off - builds a real tmpdir HOME so the fixed on-disk flag-file path is exercised for real.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  parsePersistedBackend,
  readBackendFile,
  subagentBackendFilePath,
} from "./SubagentBackend.ts";

describe("parsePersistedBackend", () => {
  it("reads a cursor payload", () => {
    const parsed = parsePersistedBackend(
      '{"schemaVersion":1,"backend":"cursor","instanceId":"cursor","model":"auto","binaryPath":"/x/agent","apiEndpoint":"","updatedAt":"2026-08-30T00:00:00.000Z"}',
    );
    expect(parsed.backend).toBe("cursor");
    expect(parsed.binaryPath).toBe("/x/agent");
    expect(parsed.degraded).toBeNull();
  });

  it("treats an unknown backend as default without reporting damage", () => {
    const parsed = parsePersistedBackend('{"schemaVersion":2,"backend":"future-thing"}');
    expect(parsed.backend).toBe("default");
    expect(parsed.degraded).toBeNull();
  });

  it("reports malformed content as degraded, still defaulting", () => {
    const parsed = parsePersistedBackend('{"backend":"cur');
    expect(parsed.backend).toBe("default");
    expect(parsed.degraded).toContain("could not be parsed");
  });

  it("reports a cursor payload with no binary as degraded", () => {
    const parsed = parsePersistedBackend(
      '{"schemaVersion":1,"backend":"cursor","instanceId":"cursor"}',
    );
    expect(parsed.backend).toBe("default");
    expect(parsed.degraded).toContain("no binary");
  });

  it("treats empty content as an absent toggle, not damage", () => {
    expect(parsePersistedBackend("").backend).toBe("default");
    expect(parsePersistedBackend("").degraded).toBeNull();
  });

  it("reads back a persisted degraded reason on a default payload — the reconciler's downgrade must survive the round trip", () => {
    const parsed = parsePersistedBackend(
      '{"schemaVersion":1,"backend":"default","instanceId":null,"degraded":"Instance \\"cursor\\" is not an enabled Cursor instance."}',
    );
    expect(parsed.backend).toBe("default");
    expect(parsed.degraded).toBe('Instance "cursor" is not an enabled Cursor instance.');
  });

  it("reads back a persisted degraded reason on a cursor payload — a still-valid instance can be degraded (e.g. an unresolvable binary)", () => {
    const parsed = parsePersistedBackend(
      '{"schemaVersion":1,"backend":"cursor","instanceId":"cursor","model":"auto","binaryPath":"agent","apiEndpoint":"","degraded":"Could not resolve \\"agent\\" on the server\'s PATH; wrote it as-is."}',
    );
    expect(parsed.backend).toBe("cursor");
    expect(parsed.degraded).toContain("Could not resolve");
  });
});

describe("readBackendFile", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sbt-read-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it.layer(NodeServices.layer)("readBackendFile", (it) => {
    it.effect("reports a read failure on an existing file as degraded, not absent", () =>
      Effect.gen(function* () {
        const filePath = yield* subagentBackendFilePath();
        // Content is irrelevant: the read itself is made to fail below, so a
        // successful parse would mean the failure was silently swallowed.
        NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
        NodeFS.writeFileSync(filePath, '{"backend":"cursor"}');

        const fs = yield* FileSystem.FileSystem;
        const recording = FileSystem.FileSystem.of({
          ...fs,
          readFileString: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: filePath,
              }),
            ),
        });

        const result = yield* readBackendFile().pipe(
          Effect.provideService(FileSystem.FileSystem, recording),
        );

        expect(result.backend).toBe("default");
        expect(result.degraded).not.toBeNull();
        expect(result.degraded).toContain("could not be read");
      }),
    );

    it.effect("treats a genuinely absent file as off, not degraded", () =>
      Effect.gen(function* () {
        const result = yield* readBackendFile();
        expect(result.backend).toBe("default");
        expect(result.degraded).toBeNull();
      }),
    );
  });
});

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimeBootId } from "../Services/RuntimeBootId.ts";

/**
 * Mints a fresh boot id once, when the layer is built (i.e. once per process
 * start). All consumers share the same memoized value.
 */
export const RuntimeBootIdLive = Layer.effect(
  RuntimeBootId,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const bootId = yield* crypto.randomUUIDv4;
    yield* Effect.logInfo("runtime.boot-id.minted", { bootId });
    return { bootId } satisfies typeof RuntimeBootId.Service;
  }),
);

/**
 * Test/explicit-value variant: pins the boot id to a caller-supplied string so
 * tests can simulate "this boot" vs "a prior boot" deterministically.
 */
export const makeRuntimeBootIdLive = (bootId: string) => Layer.succeed(RuntimeBootId, { bootId });

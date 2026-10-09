import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import { SubagentBackendSetInput } from "./subagentBackend.ts";

/** The set payload before `targetOnly` existed, as a server that predates it decodes it. */
const SetInputBeforeTargetOnly = Schema.Struct({
  backend: Schema.String,
  instanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(Schema.String),
});

const SetInputJson = Schema.toCodecJson(SubagentBackendSetInput);
const encodeSetInput = Schema.encodeSync(SetInputJson);
const decodeSetInput = Schema.decodeUnknownSync(SetInputJson);
const decodeSetInputBeforeTargetOnly = Schema.decodeUnknownSync(
  Schema.toCodecJson(SetInputBeforeTargetOnly),
);

describe("SubagentBackendSetInput on the wire", () => {
  const wire = encodeSetInput({ backend: "cursor", model: "sonnet", targetOnly: true });

  it("carries targetOnly to a server that knows it", () => {
    expect(decodeSetInput(wire).targetOnly).toBe(true);
  });

  it("is accepted by a server that predates targetOnly, which falls back to backend", () => {
    expect(decodeSetInputBeforeTargetOnly(wire)).toEqual({ backend: "cursor", model: "sonnet" });
  });
});

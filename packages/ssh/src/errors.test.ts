import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SshCommandError, SshError } from "./errors.ts";

const encodeSshError = Schema.encodeSync(SshError);
const isSshError = Schema.is(SshError);

describe("ssh errors", () => {
  it("encodes schema-backed SSH errors as tagged serializable data", () => {
    const error = new SshCommandError({
      message: "SSH command failed.",
      command: ["ssh", "devbox"],
      exitCode: 255,
      stderr: "permission denied",
    });

    assert.isTrue(isSshError(error));
    assert.deepEqual(encodeSshError(error), {
      _tag: "SshCommandError",
      message: "SSH command failed.",
      command: ["ssh", "devbox"],
      exitCode: 255,
      stderr: "permission denied",
    });
  });
});

import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

/**
 * Drops the server's inherited `NODE_OPTIONS`: a Bun-built `claude` rejects flags
 * such as `--inspect-port` and exits 1 silently. Instance overrides apply after the
 * strip, so an instance that deliberately sets `NODE_OPTIONS` still gets it.
 */
export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };

  // Windows env names are case-insensitive but this spread is a plain object.
  for (const name of Object.keys(next)) {
    if (name.toUpperCase() === "NODE_OPTIONS") {
      delete next[name];
    }
  }

  for (const variable of environment ?? []) {
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});

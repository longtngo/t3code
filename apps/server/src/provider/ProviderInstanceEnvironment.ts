import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

/**
 * Builds the environment a provider instance's child processes run under.
 *
 * The server's inherited `NODE_OPTIONS` is dropped first. It tunes *this*
 * process, and forwarding it breaks any provider CLI whose runtime rejects a
 * flag we happen to use — a Bun-built `claude` inheriting `--inspect-port`
 * exits 1 writing nothing at all, which silently broke every Claude text
 * generation. Instance overrides are applied after the strip, so an instance
 * that deliberately sets `NODE_OPTIONS` still gets it.
 */
export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };

  // Windows resolves env names case-insensitively, but this spread is an
  // ordinary object, so match on the normalized name instead of deleting a
  // single spelling.
  for (const name of Object.keys(next)) {
    if (name.toUpperCase() === "NODE_OPTIONS") {
      delete next[name];
    }
  }

  for (const variable of environment ?? []) {
    next[variable.name] = variable.value;
  }
  return next;
}

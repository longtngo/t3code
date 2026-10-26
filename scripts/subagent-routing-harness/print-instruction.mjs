/**
 * Prints the shipped instruction so the harness measures the live text, not a drifting copy.
 * `.mjs` on purpose: a `.ts` here importing `apps/server` source fails `pnpm typecheck` with
 * TS6307, since `scripts/tsconfig.json` includes every `.ts` in this tree.
 */
const adapter =
  await import("../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2Fork.ts");
process.stdout.write(adapter.subagentDispatchAppend("cursor"));

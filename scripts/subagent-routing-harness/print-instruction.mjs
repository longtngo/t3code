/**
 * Prints the dispatch instruction exactly as shipped, so the harness measures the live text
 * instead of a copy. A copy is what went wrong before: the instruction was edited twice after it
 * was measured, and nobody noticed until a reviewer compared the two.
 *
 * `.mjs`, not `.ts`, on purpose. `scripts/tsconfig.json` includes every `.ts` under this tree in
 * its own project, and a `.ts` file here that imports `apps/server` source makes `pnpm typecheck`
 * fail with TS6307 on every transitive import. No other script in this repo imports app source.
 */
const adapter = await import("../../apps/server/src/provider/Layers/ClaudeAdapter.ts");
process.stdout.write(adapter.subagentDispatchAppend("cursor"));

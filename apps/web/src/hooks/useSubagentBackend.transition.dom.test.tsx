import { RegistryContext } from "@effect/atom-react";
import { createElement, startTransition, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type SubagentBackendState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";

const fx = vi.hoisted(() => ({
  q: new Map<string, { data: unknown; isPending: boolean }>(),
  setResponse: null as unknown,
  setGate: null as Promise<void> | null,
}));
vi.mock("../state/subagentBackend", async () => {
  const { Atom } = await import("effect/reactivity");
  const ok = Atom.make(true);
  return {
    subagentBackendEnvironment: {
      get: (t: { environmentId: string; input: { refreshModels?: boolean } }) =>
        `${t.input.refreshModels === true ? "panel" : "base"}:${t.environmentId}`,
      usage: () => null,
      set: { permissionAtom: () => ok },
    },
  };
});
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    typeof atom === "string"
      ? (fx.q.get(atom) ?? { data: null, isPending: false })
      : { data: null, isPending: false },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    if (fx.setGate) await fx.setGate;
    return { _tag: "Success", value: fx.setResponse };
  },
}));

import { useSubagentBackend } from "./useSubagentBackend";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");
const st = (model: string): SubagentBackendState => ({
  backend: "cursor",
  instanceId: null,
  model,
  instances: [],
  models: [],
  degraded: null,
});
const renders: string[] = [];
const never = new Promise<void>(() => {});
function Susp(props: { env: EnvironmentId; suspend: boolean }) {
  if (props.suspend && props.env === B) throw never;
  return createElement("output", { id: "env" }, props.env);
}
function P(props: { env: EnvironmentId; suspend: boolean }) {
  renders.push(props.env);
  const { state, pending, set } = useSubagentBackend(props.env, false);
  return createElement(
    "div",
    null,
    createElement("output", { id: "model" }, state?.model ?? "none"),
    createElement("output", { id: "pending" }, pending ? "pending" : "idle"),
    createElement("button", { onClick: () => set({ backend: "cursor", targetOnly: true }) }),
    createElement(Susp, props),
  );
}

describe("useSubagentBackend discarded transition render", () => {
  it("applies the committed environment's set answer after a transition render is thrown away", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    renders.length = 0;
    fx.q = new Map([
      [`base:${A}`, { data: st("a"), isPending: false }],
      [`base:${B}`, { data: st("b"), isPending: false }],
    ]);
    let open!: () => void;
    fx.setGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fx.setResponse = st("setA");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const registry = AtomRegistry.make();
    const element = (env: EnvironmentId) =>
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(
          Suspense,
          { fallback: createElement("i", null, "fallback") },
          createElement(P, { env, suspend: true }),
        ),
      );
    const text = (selector: string) => host.querySelector(selector)?.textContent;
    try {
      root.render(element(A));
      await vi.waitFor(() => expect(text("#model")).toBe("a"));
      (host.querySelector("button") as HTMLElement).click();
      await vi.waitFor(() => expect(text("#pending")).toBe("pending"));
      // B suspends inside a transition, so React throws that render away and keeps A on screen.
      startTransition(() => root.render(element(B)));
      await vi.waitFor(() => expect(renders).toContain(B));
      open();
      await vi.waitFor(() => expect(text("#model")).toBe("setA"));
      expect(text("#env")).toBe(A);
    } finally {
      root.unmount();
      host.remove();
      fx.setGate = null;
      vi.unstubAllGlobals();
    }
  });
});

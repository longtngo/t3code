import { RegistryContext } from "@effect/atom-react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";

/**
 * `canSet` is the `set` command's own permission for the hook's environment. The command's
 * scope mapping is covered in client-runtime; this pins that the hook reports it.
 */

const fixture = vi.hoisted(() => ({
  granted: new Map<string, unknown>(),
  setResponse: null as unknown,
  setFails: false,
  /** When set, `set` waits for this promise before answering. */
  setGate: null as Promise<void> | null,
  panelQuery: { data: null as unknown, isPending: false },
  /** Answers keyed `base:<env>` (mount-time get) or `panel:<env>`; a panel key falls back to
   *  `panelQuery`, a base key to no answer. */
  queries: new Map<string, { data: unknown; isPending: boolean }>(),
}));

vi.mock("../state/subagentBackend", async () => {
  const { Atom } = await import("effect/reactivity");
  const denied = Atom.make(false);
  return {
    subagentBackendEnvironment: {
      // The panel-open `get` (it asks for a model refresh) is the one a test drives.
      get: (target: { environmentId: string; input: { refreshModels?: boolean } }) =>
        `${target.input.refreshModels === true ? "panel" : "base"}:${target.environmentId}`,
      usage: () => null,
      set: { permissionAtom: (id: string | null) => fixture.granted.get(id ?? "") ?? denied },
    },
  };
});
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    typeof atom !== "string"
      ? { data: null, isPending: false }
      : (fixture.queries.get(atom) ??
        (atom.startsWith("panel:") ? fixture.panelQuery : { data: null, isPending: false })),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    if (fixture.setGate) await fixture.setGate;
    return fixture.setFails
      ? { _tag: "Failure", cause: "rpc failed" }
      : { _tag: "Success", value: fixture.setResponse };
  },
}));

import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { SubagentBackendState } from "@t3tools/contracts";
import { useSubagentBackend } from "./useSubagentBackend";
import { renderDom } from "../testing/renderDom";

const granted = EnvironmentId.make("env-granted");
const missing = EnvironmentId.make("env-missing-scope");

function Probe(props: { readonly environmentId: EnvironmentId }) {
  const { canSet } = useSubagentBackend(props.environmentId, false);
  return createElement("output", null, canSet ? "can set" : "cannot set");
}

function renderProbe(environmentId: EnvironmentId) {
  return renderDom(
    createElement(
      RegistryContext.Provider,
      { value: AtomRegistry.make() },
      createElement(Probe, { environmentId }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.queries = new Map();
  fixture.granted = new Map([
    [granted, Atom.make(true)],
    [missing, Atom.make(false)],
  ]);
});

describe("useSubagentBackend canSet", () => {
  it("is true when the connection holds the set command's permission", async () => {
    expect((await renderProbe(granted)).text()).toBe("can set");
  });

  it("is false when the connection lacks it", async () => {
    expect((await renderProbe(missing)).text()).toBe("cannot set");
  });
});

describe("useSubagentBackend refused set", () => {
  const stored: SubagentBackendState = {
    backend: "cursor",
    instanceId: null,
    model: "auto",
    instances: [],
    models: [],
    degraded: null,
  };
  const REFUSED = "Subagent offload is switched off in Settings.";

  function RefusalProbe(props: {
    readonly environmentId: EnvironmentId;
    readonly panelOpen: boolean;
  }) {
    const { state, refusal, set } = useSubagentBackend(props.environmentId, props.panelOpen);
    return createElement(
      "div",
      null,
      createElement("output", { id: "degraded" }, state?.degraded ?? "none"),
      createElement("output", { id: "model" }, state?.model ?? "none"),
      createElement("output", { id: "refusal" }, refusal ?? "none"),
      createElement("button", { onClick: () => set({ backend: "cursor", targetOnly: true }) }),
    );
  }

  const registry = AtomRegistry.make();
  const probe = (environmentId: EnvironmentId, panelOpen = false) =>
    createElement(
      RegistryContext.Provider,
      { value: registry },
      createElement(RefusalProbe, { environmentId, panelOpen }),
    );
  type View = Awaited<ReturnType<typeof renderDom>>;
  const refusal = (view: View) => view.find("#refusal")?.textContent;

  async function refusedView() {
    fixture.setFails = false;
    fixture.setGate = null;
    fixture.panelQuery = { data: null, isPending: false };
    fixture.setResponse = { ...stored, refused: REFUSED };
    const view = await renderDom(probe(granted));
    await view.click(view.find("button"));
    await act(async () => {});
    expect(refusal(view)).toBe(REFUSED);
    return view;
  }

  it("surfaces the refusal beside the stored state instead of degrading it", async () => {
    const view = await refusedView();
    expect(view.find("#degraded")?.textContent).toBe("none");

    fixture.setResponse = stored;
    await view.click(view.find("button"));
    await act(async () => {});
    expect(refusal(view)).toBe("none");
  });

  // The user turns master on in Settings and reopens the panel: the fresh read replaces it.
  it("drops the refusal when a fresh get commits", async () => {
    const view = await refusedView();
    fixture.panelQuery = { data: null, isPending: true };
    await view.rerender(probe(granted, true));
    fixture.panelQuery = { data: { ...stored }, isPending: false };
    await view.rerender(probe(granted, true));
    expect(refusal(view)).toBe("none");
  });

  it("drops the refusal when the environment changes", async () => {
    const view = await refusedView();
    await view.rerender(probe(missing));
    expect(refusal(view)).toBe("none");
  });

  it("does not keep an old refusal over a set that then fails", async () => {
    const view = await refusedView();
    fixture.setFails = true;
    await view.click(view.find("button"));
    await act(async () => {});
    expect(refusal(view)).toBe("none");
  });

  // The get was issued before the refused set, so its answer is older than the refusal.
  it("keeps the refusal over a get that was already in flight", async () => {
    fixture.setFails = false;
    fixture.setGate = null;
    fixture.panelQuery = { data: null, isPending: false };
    const view = await renderDom(probe(granted));
    fixture.panelQuery = { data: null, isPending: true };
    await view.rerender(probe(granted, true));

    fixture.setResponse = { ...stored, refused: REFUSED };
    await view.click(view.find("button"));
    await act(async () => {});
    expect(refusal(view)).toBe(REFUSED);

    fixture.panelQuery = { data: { ...stored, model: "stale" }, isPending: false };
    await view.rerender(probe(granted, true));
    expect(refusal(view)).toBe(REFUSED);
    expect(view.find("#model")?.textContent).toBe("auto");
  });

  it("drops a set answer that lands after the environment changed", async () => {
    fixture.setFails = false;
    fixture.panelQuery = { data: null, isPending: false };
    let open!: () => void;
    fixture.setGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fixture.setResponse = { ...stored, refused: REFUSED };
    const view = await renderDom(probe(granted));
    await view.click(view.find("button"));
    await view.rerender(probe(missing));
    await act(async () => {
      open();
    });

    expect(refusal(view)).toBe("none");
    expect(view.find("#model")?.textContent).toBe("none");
  });

  // A revalidation keeps the previous answer while it is pending; that answer must not be
  // applied again under the new fetch's stamp, over a set committed since.
  it("does not re-apply a previous get answer when a revalidation starts", async () => {
    fixture.setFails = false;
    fixture.setGate = null;
    const before = { ...stored, model: "before" };
    fixture.panelQuery = { data: null, isPending: true };
    const view = await renderDom(probe(granted, true));
    fixture.panelQuery = { data: before, isPending: false };
    await view.rerender(probe(granted, true));
    expect(view.find("#model")?.textContent).toBe("before");

    fixture.setResponse = { ...stored, model: "after" };
    await view.click(view.find("button"));
    await act(async () => {});
    expect(view.find("#model")?.textContent).toBe("after");

    fixture.panelQuery = { data: before, isPending: true };
    await view.rerender(probe(granted, true));
    expect(view.find("#model")?.textContent).toBe("after");
  });

  // Switching away and back shows the cached answer again; it is the same object as before.
  it("applies an environment's cached answer again after switching away and back", async () => {
    fixture.setGate = null;
    const cached = { ...stored, model: "cached" };
    fixture.queries = new Map([
      [`panel:${granted}`, { data: cached, isPending: false }],
      [`panel:${missing}`, { data: null, isPending: false }],
    ]);
    const view = await renderDom(probe(granted, true));
    expect(view.find("#model")?.textContent).toBe("cached");
    await view.rerender(probe(missing, true));
    expect(view.find("#model")?.textContent).toBe("none");
    await view.rerender(probe(granted, true));
    expect(view.find("#model")?.textContent).toBe("cached");
  });

  it("does not re-apply a previous mount-time answer when a revalidation starts", async () => {
    fixture.setGate = null;
    const before = { ...stored, model: "before" };
    fixture.queries = new Map([[`base:${granted}`, { data: before, isPending: false }]]);
    const view = await renderDom(probe(granted));
    expect(view.find("#model")?.textContent).toBe("before");

    fixture.setResponse = { ...stored, model: "after" };
    await view.click(view.find("button"));
    await act(async () => {});
    fixture.queries.set(`base:${granted}`, { data: before, isPending: true });
    await view.rerender(probe(granted));
    expect(view.find("#model")?.textContent).toBe("after");
  });

  it("applies an environment's cached mount-time answer again after switching back", async () => {
    fixture.setGate = null;
    fixture.queries = new Map([
      [`base:${granted}`, { data: { ...stored, model: "cached" }, isPending: false }],
      [`base:${missing}`, { data: null, isPending: true }],
    ]);
    const view = await renderDom(probe(granted));
    await view.rerender(probe(missing));
    expect(view.find("#model")?.textContent).toBe("none");
    await view.rerender(probe(granted));
    expect(view.find("#model")?.textContent).toBe("cached");
  });

  // A get issued while switching to another environment is older than a set made there after.
  it("drops a get issued before a set on the environment switched to", async () => {
    fixture.setGate = null;
    fixture.queries = new Map([[`base:${granted}`, { data: stored, isPending: false }]]);
    const view = await renderDom(probe(granted));
    fixture.setResponse = { ...stored, model: "setA" };
    await view.click(view.find("button"));
    await act(async () => {});

    fixture.queries.set(`panel:${missing}`, { data: null, isPending: true });
    await view.rerender(probe(missing, true));
    fixture.setResponse = { ...stored, model: "setB" };
    await view.click(view.find("button"));
    await act(async () => {});
    expect(view.find("#model")?.textContent).toBe("setB");

    fixture.queries.set(`panel:${missing}`, {
      data: { ...stored, model: "staleB" },
      isPending: false,
    });
    await view.rerender(probe(missing, true));
    expect(view.find("#model")?.textContent).toBe("setB");
  });

  // The other half of the same rule: an answer already cached for the environment switched to
  // is not older than anything done there, so a set made before the switch must not drop it.
  it("shows the switched-to environment's cached answer after a set elsewhere", async () => {
    fixture.setGate = null;
    fixture.queries = new Map([
      [`base:${granted}`, { data: stored, isPending: false }],
      [`base:${missing}`, { data: { ...stored, model: "cachedB" }, isPending: false }],
    ]);
    const view = await renderDom(probe(granted));
    fixture.setResponse = { ...stored, model: "setA" };
    await view.click(view.find("button"));
    await act(async () => {});
    await view.rerender(probe(missing));
    expect(view.find("#model")?.textContent).toBe("cachedB");
  });
});

// A switch scheduled outside a click commits on a default lane, so React can run other work
// between the render showing the new environment and the effect that resets the hook. The race
// needs React's real scheduler, so this renders without `act`.
describe("useSubagentBackend set answer racing an environment switch", () => {
  const model = (state: SubagentBackendState | null) => state?.model ?? "none";
  let onLayout: ((environmentId: EnvironmentId) => void) | null = null;

  function LayoutProbe(props: { readonly environmentId: EnvironmentId }) {
    const { state, pending, set } = useSubagentBackend(props.environmentId, false);
    useLayoutEffect(() => {
      onLayout?.(props.environmentId);
    }, [props.environmentId]);
    return createElement(
      "div",
      null,
      createElement("output", { id: "model" }, model(state)),
      createElement("output", { id: "pending" }, pending ? "pending" : "idle"),
      createElement("button", { onClick: () => set({ backend: "cursor", targetOnly: true }) }),
    );
  }

  it("drops an old environment's answer that lands before the switch's reset runs", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    const stored: SubagentBackendState = {
      backend: "cursor",
      instanceId: null,
      model: "a",
      instances: [],
      models: [],
      degraded: null,
    };
    fixture.queries = new Map([
      [`base:${granted}`, { data: stored, isPending: false }],
      [`base:${missing}`, { data: { ...stored, model: "cachedB" }, isPending: false }],
    ]);
    let open!: () => void;
    fixture.setGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fixture.setResponse = { ...stored, model: "setA" };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const registry = AtomRegistry.make();
    const render = (environmentId: EnvironmentId) =>
      root.render(
        createElement(
          RegistryContext.Provider,
          { value: registry },
          createElement(LayoutProbe, { environmentId }),
        ),
      );
    const shown = () => host.querySelector("#model")?.textContent;
    try {
      render(granted);
      await vi.waitFor(() => expect(shown()).toBe("a"));
      (host.querySelector("button") as HTMLElement).click();
      // Wait for the click's render, so the set is in flight before the switch.
      await vi.waitFor(() => expect(host.querySelector("#pending")?.textContent).toBe("pending"));
      // The set's answer lands after B's commit, before the passive reset effect.
      onLayout = (environmentId) => {
        if (environmentId === missing) open();
      };
      render(missing);
      await vi.waitFor(() => expect(shown()).toBe("cachedB"));
    } finally {
      onLayout = null;
      root.unmount();
      host.remove();
      fixture.setGate = null;
    }
  });
});

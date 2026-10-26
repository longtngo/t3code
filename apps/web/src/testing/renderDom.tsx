import { act as reactAct } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vite-plus/test";

import type { ReactNode } from "react";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * The `dom` project's counterpart to `act` in `test/render.tsx`, which needs browser mode and so
 * cannot load here. The act flag is on only while act runs, so an update a test forgot to wrap is
 * not hidden behind a flag that stayed on for the whole file.
 */
export async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    return await reactAct(async () => await callback());
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

interface Mounted extends AsyncDisposable {
  /** The element the component was rendered into. */
  readonly container: HTMLElement;
  /** Re-render with new props, flushed like the initial mount. */
  readonly rerender: (next: ReactNode) => Promise<void>;
  /** Text content of the whole subtree, for "is this visible" assertions. */
  readonly text: () => string;
  /** First match, or null. Prefer a role or an accessible name over a class. */
  readonly find: <E extends Element = HTMLElement>(selector: string) => E | null;
  readonly findAll: <E extends Element = HTMLElement>(selector: string) => E[];
  /** Click and flush the resulting React work. */
  readonly click: (target: Element | null) => Promise<void>;
  /** Unmounts early, to test cleanup effects. */
  readonly unmount: () => Promise<void>;
}

const mounted = new Set<() => Promise<void>>();

/**
 * Real-DOM mount for the `dom` project, replacing `renderToStaticMarkup` assertions. Use `await
 * using`; leftovers are torn down after each test regardless. Trap: happy-dom's `focus()` focuses
 * non-focusable elements, so assert `el.tabIndex === 0` rather than inferring it from focus.
 */
export async function renderDom(node: ReactNode): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let live = true;
  const unmount = async () => {
    if (!live) return;
    live = false;
    await act(() => root.unmount());
  };
  const dispose = async () => {
    mounted.delete(dispose);
    try {
      await unmount();
    } finally {
      host.remove();
    }
  };
  mounted.add(dispose);

  try {
    await act(() => root.render(node));
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    container: host,
    rerender: async (next) => {
      await act(async () => {
        root.render(next);
      });
    },
    text: () => host.textContent ?? "",
    find: <E extends Element = HTMLElement>(selector: string) => host.querySelector<E>(selector),
    findAll: <E extends Element = HTMLElement>(selector: string) => [
      ...host.querySelectorAll<E>(selector),
    ],
    click: async (target) => {
      await act(async () => {
        (target as HTMLElement | null)?.click();
      });
    },
    unmount,
    [Symbol.asyncDispose]: dispose,
  };
}

afterEach(async () => {
  for (const dispose of mounted) await dispose();
});

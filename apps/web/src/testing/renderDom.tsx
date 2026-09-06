import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vite-plus/test";

import type { ReactNode } from "react";

interface Mounted {
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
}

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

/**
 * Mounts a component into a real DOM for the `dom` test project.
 *
 * Exists so the migration off `renderToStaticMarkup` does not copy the same mount/flush/cleanup
 * boilerplate into every file. Rendering to static markup and asserting on the HTML string tests
 * the shape of the markup rather than what the component does, which `AGENTS.md` rules out; this
 * gives the tests a DOM to query and events to dispatch instead.
 *
 * Every mount is torn down after the test, so a leaked root cannot leak React state into the next.
 *
 * One trap this environment carries: happy-dom's `focus()` will move `document.activeElement` onto
 * an element that is not focusable, so `el.focus(); expect(document.activeElement).toBe(el)` passes
 * even when the `tabIndex` that makes it reachable has been deleted. Assert the property you mean -
 * `el.tabIndex === 0` - rather than inferring it from focus. Found by mutation: the assertion stayed
 * green with the attribute removed.
 */
export async function renderDom(node: ReactNode): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });

  await act(async () => {
    root.render(node);
  });

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
  };
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => {
      entry.root.unmount();
    });
    entry.host.remove();
  }
});

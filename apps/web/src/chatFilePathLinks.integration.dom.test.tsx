/**
 * End-to-end test for prose file-path links through the shipped ChatMarkdown component: Words
 * builds the sanitized tree, the fork's transforms link paths and Jira keys, and the link renderer
 * mounts them. The last hops are where the feature would silently go inert.
 */
import { EnvironmentId } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "./testing/renderDom";

// Only the server-config atom for ENVIRONMENT carries Jira settings, so an
// unscoped render (no environment) reads the same empty config production does.
const atomReader = vi.hoisted(() => ({
  read: (_atom: unknown): unknown => null,
  initialValues: (): Array<readonly [never, unknown]> => [],
}));
vi.mock("./hooks/useFileMetadata", () => ({ useFileMetadata: () => null }));
vi.mock("@effect/atom-react", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  // ChatMarkdown derives its server-config fields in an atom of its own; evaluate that one for
  // real (seeded with this file's config) and keep every other read on the stub.
  const isConfigFields = (atom: unknown) =>
    (atom as { label?: readonly [string, string] }).label?.[0] === "markdown-server-config-fields";
  return {
    useAtomRefresh: () => () => undefined,
    useAtomValue: (atom: never) => {
      if (!isConfigFields(atom)) return atomReader.read(atom);
      // A fresh registry per read: an unmounted atom in a shared one is disposed after the first
      // read, and its seeded config with it, so a second render would read an empty config.
      return AtomRegistry.make({ initialValues: atomReader.initialValues() }).get(atom);
    },
  };
});
vi.mock("./hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
  useRenderedAppearance: () => "dark",
}));
vi.mock("./hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./components/ui/tooltip", async (importOriginal) => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    ...(await importOriginal<typeof import("./components/ui/tooltip")>()),
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./components/ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("./state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/query")>()),
  useEnvironmentQuery: () => ({ data: null }),
}));
vi.mock("./state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/session")>();
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});
vi.mock("./state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  readEnvironmentSupportsServerBrowser: () => false,
}));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("./editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import { serverEnvironment } from "./state/server";
import ChatMarkdown from "./components/ChatMarkdown";

const ENVIRONMENT = EnvironmentId.make("environment-1");
const CONFIG_ATOM = serverEnvironment.configValueAtom(ENVIRONMENT);
atomReader.read = (atom) =>
  atom === CONFIG_ATOM
    ? {
        settings: { jiraBaseUrl: "https://acme.atlassian.net", jiraProjectKeys: "OPS" },
        environment: { capabilities: {}, platform: { os: "darwin" } },
        availableEditors: [],
      }
    : null;
atomReader.initialValues = () => [[CONFIG_ATOM as never, atomReader.read(CONFIG_ATOM)]];

const CWD = "/Users/dev/project";

function render(markdown: string) {
  return renderDom(<ChatMarkdown cwd={CWD} environmentId={ENVIRONMENT} text={markdown} />);
}

const TICKET = 'a[href="https://acme.atlassian.net/browse/OPS-12"]';

describe("chat file-path links (ChatMarkdown)", () => {
  it("renders an anchor whose href is the absolute path", async () => {
    const view = await render("I edited /Users/dev/project/src/main.ts today.");
    expect(view.find('a[href="/Users/dev/project/src/main.ts"]')).not.toBeNull();
  });

  it("keeps a line suffix on the href instead of blanking it", async () => {
    const view = await render("Failure at /Users/dev/project/src/main.ts:42:7 in the parser.");
    expect(view.find('a[href="/Users/dev/project/src/main.ts:42:7"]')).not.toBeNull();
  });

  it("resolves a cwd-relative path to an absolute href", async () => {
    const view = await render("Check src/lib/util.ts for the helper.");
    expect(view.find('a[href="/Users/dev/project/src/lib/util.ts"]')).not.toBeNull();
  });

  it("leaves a path inside inline code to ChatMarkdown's own code renderer", async () => {
    // The prose transform only linkifies PROSE. ChatMarkdown's `code` renderer swaps a
    // path-only inline span for one file chip; linkifying here too nested a chip inside the
    // bordered inline-code element and drew two frames.
    const view = await render("The entry point is `/Users/dev/project/src/main.ts` now.");
    expect(view.findAll(".chat-markdown-file-link")).toHaveLength(1);
    expect(view.find("code a, a code")).toBeNull();
    // The chip replaces the code span rather than sitting inside it.
    expect(view.find("code")).toBeNull();
  });

  it("resolves a bare filename from an absolute path stated earlier", async () => {
    const view = await render(
      "I rewrote /Users/dev/project/src/lib/util.ts.\n\nAfter that, util.ts exports a helper.",
    );
    // Both the full path and the later shorthand point at the same file.
    expect(view.findAll('a[href="/Users/dev/project/src/lib/util.ts"]')).toHaveLength(2);
  });

  it("leaves fenced code alone", async () => {
    const view = await render("```sh\ncat /Users/dev/project/src/main.ts\n```");
    expect(view.find("a")).toBeNull();
    expect(view.text()).toContain("cat /Users/dev/project/src/main.ts");
  });

  it("does not double-wrap an existing markdown link", async () => {
    const view = await render("See [the entry](/Users/dev/project/src/main.ts) for details.");
    expect(view.findAll("a")).toHaveLength(1);
  });

  it("leaves ordinary prose untouched", async () => {
    const view = await render("We discussed the plan and agreed on the approach.");
    expect(view.find("a")).toBeNull();
  });

  it("links a Jira ticket key next to a file path", async () => {
    const view = await render("OPS-12 broke /Users/dev/project/src/main.ts again.");
    expect(view.find(TICKET)?.getAttribute("data-markdown-copy")).toBe("OPS-12");
    expect(view.find('a[href="/Users/dev/project/src/main.ts"]')).not.toBeNull();
  });
});

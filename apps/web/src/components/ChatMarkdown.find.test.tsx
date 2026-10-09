// @vitest-environment jsdom
// Upstream's thread-find highlight cases (#10439), split out of ChatMarkdown.dom.test.tsx because
// upstream runs them under jsdom: under happy-dom the Mermaid case counts its one match twice.

import { EnvironmentId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { createRoot } from "react-dom/client";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

import { MarkdownFindContext } from "./chat/markdownFindContext";
import { act, type ComponentProps, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("./chat/MermaidDiagram", () => ({
  // Real Mermaid needs layout APIs jsdom lacks; a rendered diagram is an SVG.
  MermaidDiagram: () => <svg aria-label="Diagram" />,
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/session")>();
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const grantedScopes = new Set<AuthEnvironmentScope>(AuthStandardClientScopes);
  const hasScope = (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null && grantedScopes.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  readEnvironmentSupportsServerBrowser: () => false,
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

it.each([
  {
    text: "```mermaid\ngraph TD; SearchSourceAlpha-->B\n```",
    query: "SearchSourceAlpha",
    count: 1,
  },
  {
    text: "★ Insight ─────\nfirst line\nsecond line",
    query: "first line second",
    count: 0,
    lineBreaks: true,
  },
  { text: '```ts title="src/needle.ts"\nconst a = 1;\n```', query: "needle", count: 0 },
  { text: "```weirdlang\nconst a = 1;\n```", query: "weirdlang", count: 0 },
  { text: "Use $test-t3-app now", query: "T3 App Testing", count: 1 },
  { text: "`/tmp/file.ts:42`", query: "file.ts · L42", count: 1, user: true, lineBreaks: true },
  { text: "> [!NOTE]\n> Searchable alert", query: "Searchable alert", count: 1 },
  {
    text: "<details><summary>Folded</summary><p>Hidden needle</p></details>",
    query: "Hidden needle",
    count: 1,
  },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, useTemplate: true },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Document template", count: 1, useTemplate: true },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "World Document", count: 0, useTemplate: true },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, useTemplate: true },
])(
  "highlights the indexed occurrences of $query in $text",
  async ({ text, query, count, lineBreaks, user, useTemplate }) => {
    const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];
    const highlights = new Map<string, Set<Range>>();
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      },
    );
    vi.stubGlobal("CSS", { highlights, escape: (value: string) => value });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Probe() {
      useThreadFindHighlights({
        container,
        query,
        activeRowId: "row",
        activeOccurrence: 0,
        onActiveRange: () => {},
      });
      return (
        <div data-timeline-row-id="row">
          <div data-thread-find-text>
            <MarkdownFindContext value={true}>
              <ChatMarkdown
                text={text}
                cwd={undefined}
                skills={skills}
                lineBreaks={lineBreaks ?? false}
                parseRawHtml={!user}
                onUseArtifactTemplate={useTemplate ? () => undefined : undefined}
              />
            </MarkdownFindContext>
          </div>
        </div>
      );
    }
    try {
      await act(() => root.render(<Probe />));
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const ranges = [...highlights.values()].flatMap((value) => [...value]);
      expect(ranges.map((range) => range.toString())).toEqual(
        Array.from({ length: count }, () => query),
      );
      const segments =
        searchableMessageSegments(
          { role: user ? "user" : "assistant", text, streaming: false },
          undefined,
          skills,
        ) ?? [];
      expect(
        segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
      ).toBe(count);
    } finally {
      await act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

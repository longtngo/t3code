import { EnvironmentId } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";

// Only the server-config atom for ENVIRONMENT carries Jira settings, so an
// unscoped render (no environment) reads the same empty config production does.
const atomReader = vi.hoisted(() => ({ read: (_atom: unknown): unknown => null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: unknown) => atomReader.read(atom) }));
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
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
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
  useOpenChangeRequestLink: () => vi.fn(),
}));

import { serverEnvironment } from "../state/server";
import ChatMarkdown from "./ChatMarkdown";

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

const TICKET = 'a[href="https://acme.atlassian.net/browse/OPS-12"]';

describe("ChatMarkdown Jira ticket links", () => {
  it("links a ticket key in prose to the configured Jira site", async () => {
    const view = await renderDom(
      <ChatMarkdown cwd="/tmp/project" environmentId={ENVIRONMENT} text="OPS-12 is broken" />,
    );
    const anchor = view.find(TICKET);
    expect(anchor?.textContent).toBe("OPS-12");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("data-markdown-copy")).toBe("OPS-12");
  });

  it("leaves keys in inline code and authored links alone", async () => {
    for (const text of [
      "`OPS-12`",
      "[OPS-12](https://example.com)",
      '<a href="https://example.com">OPS-12</a>',
      "```\nOPS-12\n```",
      "<code>OPS-12</code>",
    ]) {
      const view = await renderDom(
        <ChatMarkdown cwd="/tmp/project" environmentId={ENVIRONMENT} text={text} />,
      );
      expect(view.text()).toContain("OPS-12");
      expect(view.find(TICKET)).toBeNull();
    }
  });

  it("keeps a path that contains a key as one file chip", async () => {
    const view = await renderDom(
      <ChatMarkdown cwd="/tmp/project" environmentId={ENVIRONMENT} text="open OPS-12/readme.md" />,
    );
    expect(view.findAll(".chat-markdown-file-link")).toHaveLength(1);
    expect(view.find(TICKET)).toBeNull();
  });

  it("does not link without an environment to read settings from", async () => {
    const view = await renderDom(<ChatMarkdown cwd="/tmp/project" text="OPS-12 is broken" />);
    expect(view.text()).toContain("OPS-12 is broken");
    expect(view.find("a")).toBeNull();
  });
});

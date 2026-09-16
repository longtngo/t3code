import { resolveJiraTicketLinks } from "@t3tools/shared/jiraTicketLinks";
import { describe, expect, it } from "vite-plus/test";

import { JIRA_TICKET_LINK_ATTRIBUTE, rehypeJiraTicketLinks } from "./rehypeJiraTicketLinks";

// Hand-built hast, the shape react-markdown hands rehype plugins after rehypeRaw:
// raw `<a>`/`<code>` and markdown links/code are the same elements by then.
interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const links = resolveJiraTicketLinks("https://acme.atlassian.net", "OPS")!;
const JIRA_URL = "https://acme.atlassian.net/browse/OPS-1";

const text = (value: string): Node => ({ type: "text", value });
const element = (
  tagName: string,
  children: Node[],
  properties?: Record<string, unknown>,
): Node => ({
  type: "element",
  tagName,
  children,
  ...(properties ? { properties } : {}),
});

function anchors(node: Node): Node[] {
  const own = node.type === "element" && node.tagName === "a" ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap(anchors)];
}

function jiraAnchors(tree: Node): Node[] {
  return anchors(tree).filter((anchor) => anchor.properties?.href === JIRA_URL);
}

describe("rehypeJiraTicketLinks", () => {
  it("links a key in prose, headings, table cells and emphasis", () => {
    for (const block of [
      element("p", [text("fix OPS-1 now")]),
      element("h1", [text("OPS-1")]),
      element("table", [element("tbody", [element("tr", [element("td", [text("OPS-1")])])])]),
      element("p", [element("strong", [text("OPS-1")])]),
    ]) {
      const tree = element("root", [block]);
      rehypeJiraTicketLinks(links)(tree);
      expect(jiraAnchors(tree)).toHaveLength(1);
    }
  });

  it("splits the surrounding text around the anchor", () => {
    const paragraph = element("p", [text("fix OPS-1 and OPS-2 now")]);
    rehypeJiraTicketLinks(links)(element("root", [paragraph]));
    expect(
      paragraph.children!.map((child) =>
        child.type === "text" ? `text:${child.value}` : `a:${child.properties?.href}`,
      ),
    ).toEqual([
      "text:fix ",
      `a:${JIRA_URL}`,
      "text: and ",
      "a:https://acme.atlassian.net/browse/OPS-2",
      "text: now",
    ]);
  });

  it("never links inside code, pre, or existing links", () => {
    for (const block of [
      element("p", [element("code", [text("OPS-1")])]),
      element("pre", [element("code", [text("OPS-1")])]),
      element("p", [element("a", [text("OPS-1")], { href: "https://e.com" })]),
      element("p", [
        element("span", [element("a", [element("em", [text("OPS-1")])], { href: "x" })]),
      ]),
    ]) {
      const tree = element("root", [block]);
      rehypeJiraTicketLinks(links)(tree);
      expect(jiraAnchors(tree)).toHaveLength(0);
    }
  });

  it("marks created anchors with the key", () => {
    const tree = element("root", [element("p", [text("OPS-1")])]);
    rehypeJiraTicketLinks(links)(tree);
    expect(jiraAnchors(tree)[0]?.properties?.[JIRA_TICKET_LINK_ATTRIBUTE]).toBe("OPS-1");
    expect(jiraAnchors(tree)[0]?.children).toEqual([text("OPS-1")]);
  });
});

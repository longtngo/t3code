/**
 * Rehype plugin that links Jira ticket keys in chat and document markdown.
 * Runs after raw HTML is parsed and after file-path links, so authored links,
 * code, and paths that contain a key are left alone.
 *
 * @module rehypeJiraTicketLinks
 */
import {
  findJiraTicketMatches,
  jiraTicketUrl,
  type JiraTicketLinks,
} from "@t3tools/shared/jiraTicketLinks";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIPPED_TAGS = new Set(["pre", "code", "a", "script", "style"]);

/** Marks anchors this plugin created; the value is the key, used as copy text. */
export const JIRA_TICKET_LINK_ATTRIBUTE = "dataJiraTicket";

function linkify(value: string, links: JiraTicketLinks): HastNode[] | null {
  const matches = findJiraTicketMatches(value, links);
  if (matches.length === 0) return null;
  const output: HastNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor)
      output.push({ type: "text", value: value.slice(cursor, match.start) });
    output.push({
      type: "element",
      tagName: "a",
      properties: {
        href: jiraTicketUrl(links, match.key),
        [JIRA_TICKET_LINK_ATTRIBUTE]: match.key,
      },
      children: [{ type: "text", value: match.key }],
    });
    cursor = match.end;
  }
  if (cursor < value.length) output.push({ type: "text", value: value.slice(cursor) });
  return output;
}

export function rehypeJiraTicketLinks(links: JiraTicketLinks) {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (!node.children) return;
      let changed = false;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string") {
          const replacement = linkify(child.value, links);
          if (replacement) {
            next.push(...replacement);
            changed = true;
            continue;
          }
        } else if (!(child.type === "element" && SKIPPED_TAGS.has(child.tagName ?? ""))) {
          visit(child);
        }
        next.push(child);
      }
      if (changed) node.children = next;
    };
    visit(tree);
  };
}

/**
 * Rehype plugin that turns plain-text file paths in a chat message into anchors.
 *
 * The anchors carry the resolved *absolute* path as their href, which is what the
 * file viewer needs. They are ordinary `<a>` elements, so `ChatMarkdown`'s
 * existing anchor renderer picks them up and renders the same file chip it
 * already renders for `[label](path)` links — no second rendering path.
 *
 * Deliberately skipped:
 *  - `pre` subtrees, so fenced code keeps its syntax highlighting untouched
 *  - existing `a` subtrees, so a real markdown link is never nested inside one
 *
 * Inline `code` IS linkified, because a path written as `` `src/main.ts` `` is
 * the single most common way one shows up in a message.
 *
 * @module rehypeChatFilePathLinks
 */
import {
  findChatFilePathMentions,
  type ChatFilePathResolution,
} from "./chatFilePathLinks";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Elements whose text must stay verbatim. */
const SKIPPED_TAGS = new Set(["pre", "a", "script", "style"]);

/** Marks anchors this plugin created, so the renderer can tell them apart. */
export const CHAT_FILE_PATH_LINK_ATTRIBUTE = "dataChatFilePath";

function textNode(value: string): HastNode {
  return { type: "text", value };
}

function anchorNode(href: string, label: string): HastNode {
  return {
    type: "element",
    tagName: "a",
    properties: { href, [CHAT_FILE_PATH_LINK_ATTRIBUTE]: "true" },
    children: [textNode(label)],
  };
}

/**
 * Split one text node into alternating plain-text and anchor nodes. Returns
 * `null` when the text holds no resolvable path, so the caller can leave the
 * original node untouched rather than rebuild an identical one.
 */
function linkifyTextValue(value: string, options: ChatFilePathResolution): HastNode[] | null {
  const mentions = findChatFilePathMentions(value, options);
  if (mentions.length === 0) return null;

  const output: HastNode[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start > cursor) {
      output.push(textNode(value.slice(cursor, mention.start)));
    }
    output.push(anchorNode(mention.targetPath, mention.raw));
    cursor = mention.end;
  }
  if (cursor < value.length) {
    output.push(textNode(value.slice(cursor)));
  }
  return output;
}

/** Concatenated text of a node's direct text children, or null if it has any others. */
function plainTextOf(node: HastNode): string | null {
  const children = node.children ?? [];
  let text = "";
  for (const child of children) {
    if (child.type !== "text" || typeof child.value !== "string") return null;
    text += child.value;
  }
  return text;
}

/**
 * The anchor for a `code` element that contains nothing but a single resolvable
 * path, or null when it holds anything else (so the caller linkifies in place).
 */
function soleFilePathAnchor(node: HastNode, options: ChatFilePathResolution): HastNode | null {
  const text = plainTextOf(node);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const mentions = findChatFilePathMentions(trimmed, options);
  const only = mentions[0];
  if (mentions.length !== 1 || only === undefined) return null;
  if (only.raw !== trimmed) return null;
  return anchorNode(only.targetPath, only.raw);
}

export function rehypeChatFilePathLinks(options: ChatFilePathResolution) {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      const children = node.children;
      if (!children || children.length === 0) return;

      const next: HastNode[] = [];
      let changed = false;
      for (const child of children) {
        // An inline `code` whose entire content is one path becomes the chip
        // itself. Left nested, the code element's own border and background frame
        // the chip, which then draws a second border inside the first.
        if (child.type === "element" && child.tagName === "code") {
          const only = soleFilePathAnchor(child, options);
          if (only) {
            next.push(only);
            changed = true;
            continue;
          }
        }
        if (child.type === "text" && typeof child.value === "string") {
          const replacement = linkifyTextValue(child.value, options);
          if (replacement) {
            next.push(...replacement);
            changed = true;
            continue;
          }
          next.push(child);
          continue;
        }
        if (!(child.type === "element" && SKIPPED_TAGS.has(child.tagName ?? ""))) {
          visit(child);
        }
        next.push(child);
      }

      if (changed) node.children = next;
    };

    visit(tree);
  };
}

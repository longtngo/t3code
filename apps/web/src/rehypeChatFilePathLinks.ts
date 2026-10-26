/**
 * Turns plain-text file paths into ordinary `<a>` elements with the absolute path as href, so
 * `ChatMarkdown`'s anchor renderer draws the same chip as for `[label](path)`. Skips `pre`
 * (keeps highlighting) and `a` (no nested links); inline `code` is owned by ChatMarkdown's renderer.
 */
import { findChatFilePathMentions, type ChatFilePathResolution } from "./chatFilePathLinks";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Elements this plugin must not touch.
 *
 * `code` is skipped because ChatMarkdown's own `code` renderer already turns an
 * inline span that is just a path into a file chip. Linkifying here as well
 * nested a chip inside the bordered inline-code element and drew two frames.
 */
const SKIPPED_TAGS = new Set(["pre", "code", "a", "script", "style"]);

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
 * Well-formed Codex citations become links before this plugin runs, so a surviving literal
 * directive is unfinished, malformed, escaped, or lookalike. Its `path="…"` must not be linkified:
 * a half-arrived citation would flash a link, and literal text would become a control.
 */
const CODEX_FILE_CITATION_DIRECTIVE = /:codex-file-citation/;

/**
 * Split one text node into alternating plain-text and anchor nodes. Returns
 * `null` when the text holds no resolvable path, so the caller can leave the
 * original node untouched rather than rebuild an identical one.
 */
function linkifyTextValue(value: string, options: ChatFilePathResolution): HastNode[] | null {
  if (CODEX_FILE_CITATION_DIRECTIVE.test(value)) return null;
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

export function rehypeChatFilePathLinks(options: ChatFilePathResolution) {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      const children = node.children;
      if (!children || children.length === 0) return;

      const next: HastNode[] = [];
      let changed = false;
      for (const child of children) {
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

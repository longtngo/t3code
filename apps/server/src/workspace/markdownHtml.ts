/**
 * markdownHtml - pure helpers for on-demand markdown→HTML rendering.
 *
 * `renderMarkdownDocument` turns markdown source into a complete, self-contained
 * `<!doctype html>` document (GitHub-flavored body + embedded styles) suitable
 * for the file-viewer's sandboxed iframe and for "open in new tab". The document
 * carries no external resources, so it renders identically offline and when
 * popped out. `createMarkdownHtmlCache` is a small LRU used by the workspace file
 * system to avoid re-converting an unchanged file within a server process.
 *
 * @module markdownHtml
 */
import { marked } from "marked";

// Compact, readable, self-contained stylesheet. Intentionally light-themed to
// match the white iframe background used for HTML reports elsewhere in the app.
const DOCUMENT_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2.5rem 1.5rem 4rem;
  background: #ffffff;
  color: #1f2328;
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
.markdown-body { max-width: 52rem; margin: 0 auto; }
.markdown-body > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { margin: 1.6em 0 0.6em; font-weight: 600; line-height: 1.25; }
h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 2em; }
li + li { margin-top: 0.25em; }
blockquote {
  margin-left: 0;
  padding: 0 1em;
  color: #59636e;
  border-left: 0.25em solid #d1d9e0;
}
code {
  font: 0.85em/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  background: rgba(129, 139, 152, 0.16);
  padding: 0.2em 0.4em;
  border-radius: 6px;
}
pre {
  background: #f6f8fa;
  padding: 1em;
  border-radius: 8px;
  overflow: auto;
}
pre code { background: none; padding: 0; font-size: 0.85em; }
table { border-collapse: collapse; display: block; overflow: auto; width: max-content; max-width: 100%; }
th, td { padding: 0.5em 0.85em; border: 1px solid #d1d9e0; }
th { background: #f6f8fa; font-weight: 600; }
tr:nth-child(2n) td { background: #f6f8fa80; }
img { max-width: 100%; }
hr { height: 1px; border: 0; background: #d1d9e0; margin: 2em 0; }
`.trim();

const HTML_HEAD =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<style>${DOCUMENT_STYLES}</style></head><body><article class="markdown-body">`;
const HTML_TAIL = "</article></body></html>";

/**
 * Render markdown source to a complete standalone HTML document. Synchronous:
 * `marked` is configured without async extensions, so `parse` returns a string.
 * Raw HTML inside the markdown is passed through unchanged — the consumer renders
 * the result in a sandboxed (no-same-origin) iframe, which is the trust boundary,
 * matching how raw `.html` report files are already displayed.
 */
export function renderMarkdownDocument(markdown: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true, breaks: false });
  return HTML_HEAD + body + HTML_TAIL;
}

/** One cached conversion, validated against the source file's stat + content. */
export interface MarkdownHtmlCacheEntry {
  /** File modification time in ms (`undefined` when the platform omits mtime). */
  readonly mtimeMs: number | undefined;
  /** File size in bytes — paired with mtime for the cheap validity check. */
  readonly size: number;
  /** SHA-256 of the file contents — the authoritative change check. */
  readonly hash: string;
  /** The rendered standalone HTML document. */
  readonly html: string;
}

export interface MarkdownHtmlCache {
  get(key: string): MarkdownHtmlCacheEntry | undefined;
  set(key: string, entry: MarkdownHtmlCacheEntry): void;
}

const DEFAULT_MAX_ENTRIES = 64;

/**
 * Bounded LRU keyed by resolved file path. Eviction is least-recently-used:
 * reads re-insert the key, and a `set` past the cap drops the oldest key. Sized
 * for the handful of reports a user views in a session, not for bulk storage.
 */
export function createMarkdownHtmlCache(maxEntries = DEFAULT_MAX_ENTRIES): MarkdownHtmlCache {
  // Guard against a non-positive cap, which would make the eviction loop spin.
  const cap = Math.max(1, Math.floor(maxEntries));
  const entries = new Map<string, MarkdownHtmlCacheEntry>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      // Mark most-recently-used by re-inserting at the tail.
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key, entry) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, entry);
      while (entries.size > cap) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

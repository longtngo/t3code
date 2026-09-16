/**
 * Jira ticket keys in rendered text. Both the web markdown renderer and the
 * mobile native text runs call `findJiraTicketMatches`, so they agree on what
 * links.
 */
export interface JiraTicketLinks {
  readonly base: string;
  readonly pattern: RegExp;
}

interface JiraTicketMatch {
  readonly start: number;
  readonly end: number;
  readonly key: string;
}

// Checked before uppercasing: "ß".toUpperCase() is "SS".
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/u;
// Hiragana, Katakana and Han text has no spaces between words, so those
// letters do not make a key part of a larger word. Explicit ranges rather than
// `\p{Script=…}`, which Hermes is not known to support.
const WORD = /(?![぀-ヿ㐀-䶿一-鿿豈-﫿])[\p{L}\p{N}_]/u;
// "$" is a skill chip prefix on web.
const BEFORE_PUNCTUATION = new Set(["/", "\\", "-", "#", "?", "=", "&", "$"]);
const AFTER_PUNCTUATION = new Set(["-", "/", "\\"]);

/** The entered project-key entries that would be dropped: empty ones are not typos, so they are ignored. */
export function invalidJiraProjectKeys(projectKeys: string): ReadonlyArray<string> {
  return projectKeys
    .split(/[\s,]+/u)
    .filter((key) => key !== "")
    .filter((key) => !PROJECT_KEY.test(key));
}

/** Null when the settings cannot produce a safe link, which turns linking off. */
export function resolveJiraTicketLinks(
  baseUrl: string,
  projectKeys: string,
): JiraTicketLinks | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const keys = [
    ...new Set(
      projectKeys
        .split(/[\s,]+/u)
        .filter((key) => PROJECT_KEY.test(key))
        .map((key) => key.toUpperCase()),
    ),
  ];
  if (keys.length === 0) return null;
  return {
    base: `${url.origin}${url.pathname.replace(/\/+$/u, "")}`,
    pattern: new RegExp(`(?:${keys.join("|")})-[1-9]\\d*`, "gu"),
  };
}

export function jiraTicketUrl(links: JiraTicketLinks, key: string): string {
  return `${links.base}/browse/${key}`;
}

function isWord(character: string | undefined): boolean {
  return character !== undefined && WORD.test(character);
}

/** A whitespace-bounded token that holds a URL or an email address. */
function isUrlOrEmail(token: string): boolean {
  return token.includes("://") || token.startsWith("www.") || token.includes("@");
}

export function findJiraTicketMatches(
  text: string,
  links: JiraTicketLinks,
): ReadonlyArray<JiraTicketMatch> {
  const matches: JiraTicketMatch[] = [];
  // matchAll starts from the pattern's lastIndex, which other callers may have moved.
  links.pattern.lastIndex = 0;
  // Keys in one space-free run share a token, so each token is scanned once.
  let tokenEnd = -1;
  let tokenIsUrlOrEmail = false;
  for (const match of text.matchAll(links.pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text[start - 1];
    const after = text[end];
    if (isWord(before) || (before !== undefined && BEFORE_PUNCTUATION.has(before))) continue;
    if (isWord(after) || (after !== undefined && AFTER_PUNCTUATION.has(after))) continue;
    if (after === "." && isWord(text[end + 1])) continue;
    if (start >= tokenEnd) {
      let tokenStart = start;
      while (tokenStart > 0 && !/\s/u.test(text[tokenStart - 1]!)) tokenStart -= 1;
      tokenEnd = end;
      while (tokenEnd < text.length && !/\s/u.test(text[tokenEnd]!)) tokenEnd += 1;
      tokenIsUrlOrEmail = isUrlOrEmail(text.slice(tokenStart, tokenEnd));
    }
    if (tokenIsUrlOrEmail) continue;
    matches.push({ start, end, key: match[0] });
  }
  return matches;
}

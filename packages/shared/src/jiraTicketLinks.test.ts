import { describe, expect, it } from "vite-plus/test";

import {
  findJiraTicketMatches,
  invalidJiraProjectKeys,
  jiraTicketUrl,
  resolveJiraTicketLinks,
} from "./jiraTicketLinks.ts";

const links = resolveJiraTicketLinks("https://acme.atlassian.net/", "OPS, DRST")!;
const keys = (text: string) => findJiraTicketMatches(text, links).map((match) => match.key);

describe("resolveJiraTicketLinks", () => {
  it("returns null without a usable http(s) URL or any valid key", () => {
    expect(resolveJiraTicketLinks("", "OPS")).toBeNull();
    expect(resolveJiraTicketLinks("example.atlassian.net", "OPS")).toBeNull();
    expect(resolveJiraTicketLinks("javascript:alert(1)", "OPS")).toBeNull();
    expect(resolveJiraTicketLinks("ftp://x", "OPS")).toBeNull();
    expect(resolveJiraTicketLinks("https://acme.atlassian.net", "")).toBeNull();
    expect(resolveJiraTicketLinks("https://acme.atlassian.net", "x-y, 1AB, ,")).toBeNull();
    // Uppercasing these yields ASCII-looking keys ("SS", "I", "FI"); validate the raw input.
    expect(resolveJiraTicketLinks("https://acme.atlassian.net", "ß, ı, ﬁ")).toBeNull();
  });

  it("normalizes the base and keys", () => {
    const resolved = resolveJiraTicketLinks(
      "https://u:p@jira.acme.com/jira/?x=1#f",
      " ops ,drst ops",
    );
    expect(resolved?.base).toBe("https://jira.acme.com/jira");
    expect(jiraTicketUrl(resolved!, "OPS-12")).toBe("https://jira.acme.com/jira/browse/OPS-12");
    expect(resolveJiraTicketLinks("http://[::1]:8080/j", "OPS")?.base).toBe("http://[::1]:8080/j");
  });
});

describe("invalidJiraProjectKeys", () => {
  it("names the entries that fail the project key check", () => {
    expect(invalidJiraProjectKeys("OPS, DRST-12, ß")).toEqual(["DRST-12", "ß"]);
    expect(invalidJiraProjectKeys("ops drst")).toEqual([]);
    expect(invalidJiraProjectKeys("")).toEqual([]);
  });
});

describe("findJiraTicketMatches", () => {
  it("links standalone keys with offsets", () => {
    expect(findJiraTicketMatches("see OPS-1234.", links)).toEqual([
      { start: 4, end: 12, key: "OPS-1234" },
    ]);
    expect(keys("(DRST-5), OPS-6! **OPS-7**")).toEqual(["DRST-5", "OPS-6", "OPS-7"]);
    expect(keys("OPS-123を修正 修正OPS-124 チケットOPS-1の件")).toEqual([
      "OPS-123",
      "OPS-124",
      "OPS-1",
    ]);
  });

  it.each([
    "ABOPS-1",
    "éOPS-1",
    "한국어OPS-1",
    "OPS-12a",
    "OPS-11é",
    "feat/OPS-1",
    "a\\OPS-1",
    "OPS-1-fix",
    "X-OPS-1",
    "OPS-28.md",
    "OPS-24.5",
    "?q=OPS-6",
    "x=OPS-15",
    "&OPS-3",
    "$OPS-12",
    "#OPS-9",
    "OPS-8@x.com",
    "www.x.com/?k=OPS-7",
    "https://x.com/OPS-2",
    "OPS-12/readme.md",
    "OPS-0",
    "ops-1",
    "OTHER-1",
  ])("does not link %s", (text) => {
    expect(keys(text)).toEqual([]);
  });

  it("handles many keys in one space-free run", () => {
    const run = Array.from({ length: 5000 }, (_, index) => `OPS-${index + 1}`).join(",");
    expect(keys(run)).toHaveLength(5000);
    expect(keys(`https://x.com/${run}`)).toEqual([]);
    expect(keys(`${run},https://x.com`)).toEqual([]);
  });

  it("prefers the longest overlapping key regardless of key order", () => {
    const shortFirst = resolveJiraTicketLinks("https://j.example", "OP, OPS")!;
    expect(findJiraTicketMatches("OPS-1", shortFirst).map((match) => match.key)).toEqual(["OPS-1"]);
    const longFirst = resolveJiraTicketLinks("https://j.example", "OPS, OP")!;
    expect(findJiraTicketMatches("OPS-1", longFirst).map((match) => match.key)).toEqual(["OPS-1"]);
  });

  it("is not affected by prior stateful use of the shared pattern", () => {
    links.pattern.exec("OPS-9 zzzzzzzzzzzzzzzzzzzz");
    expect(keys("OPS-2 x")).toEqual(["OPS-2"]);
  });
});

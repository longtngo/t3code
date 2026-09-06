import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkGithubAlerts } from "./markdown-github-alerts";
import { renderDom } from "./testing/renderDom";

function renderMarkdown(markdown: string) {
  return renderDom(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkGithubAlerts]}>{markdown}</ReactMarkdown>,
  );
}

describe("remarkGithubAlerts", () => {
  it("tags a quote whose first line is a marker, and drops the marker line", async () => {
    const view = await renderMarkdown("> [!NOTE]\n> The content of the note.");

    expect(view.find('[data-alert="note"]')).not.toBeNull();
    expect(view.text()).not.toContain("[!NOTE]");
    expect(view.text()).toContain("The content of the note.");
  });

  it("keeps content that follows a marker-only paragraph", async () => {
    const view = await renderMarkdown("> [!WARNING]\n>\n> ### A heading\n>\n> And a paragraph.");

    expect(view.find('[data-alert="warning"]')).not.toBeNull();
    expect(view.text()).not.toContain("[!WARNING]");
    expect(view.text()).toContain("A heading");
    expect(view.text()).toContain("And a paragraph.");
  });

  it("tags a quote whose next line opens with an inline node rather than text", async () => {
    const view = await renderMarkdown(
      "> [!NOTE]\n> **Medium Risk** Changes live transcript routing.",
    );

    expect(view.find('[data-alert="note"]')).not.toBeNull();
    expect(view.text()).not.toContain("[!NOTE]");
    expect(view.find("strong")?.textContent).toBe("Medium Risk");
    expect(view.text()).toContain("Changes live transcript routing.");
  });

  it("reads the marker case-insensitively, normalizing the kind", async () => {
    const view = await renderMarkdown("> [!important]\n> Read this.");

    expect(view.find('[data-alert="important"]')).not.toBeNull();
  });

  it("leaves a quote alone when the marker shares its line with anything else", async () => {
    const view = await renderMarkdown("> [!NOTE] an ordinary quote");

    expect(view.find("[data-alert]")).toBeNull();
    expect(view.text()).toContain("[!NOTE] an ordinary quote");
  });

  it("leaves an unknown marker as the text it is", async () => {
    const view = await renderMarkdown("> [!DANGER]\n> Not one of GitHub's.");

    expect(view.find("[data-alert]")).toBeNull();
    expect(view.text()).toContain("[!DANGER]");
  });
});

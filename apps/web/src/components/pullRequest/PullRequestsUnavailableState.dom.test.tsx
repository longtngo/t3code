import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

describe("PullRequestsUnavailableState", () => {
  it("can explain an unsupported environment without offering a futile retry", async () => {
    const view = await renderDom(
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's T3 Code server to browse pull requests."
      />,
    );

    expect(view.text()).toContain("Pull requests unavailable");
    expect(view.text()).toContain("Update this environment's T3 Code server");
    expect(view.text()).not.toContain("Retry");
  });

  it("retains the retry for transient load failures", async () => {
    const view = await renderDom(
      <PullRequestsUnavailableState
        error="GitHub did not answer."
        onRetry={() => {}}
        gitHubUrl="https://github.com/pingdotgg/t3code/pull/42"
      />,
    );

    expect(view.text()).toContain("Retry");
    expect(view.text()).toContain("Open on GitHub");
    const link = view.find<HTMLAnchorElement>("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/pingdotgg/t3code/pull/42");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("can offer the browser without offering a retry", async () => {
    const view = await renderDom(
      <PullRequestsUnavailableState
        error="This server cannot read the pull request."
        gitHubUrl="https://github.com/pingdotgg/t3code/pull/9"
      />,
    );

    expect(view.text()).toContain("Open on GitHub");
    expect(view.text()).not.toContain("Retry");
  });

  it("can offer a retry without offering GitHub", async () => {
    const view = await renderDom(
      <PullRequestsUnavailableState error="The host did not answer." onRetry={() => {}} />,
    );

    expect(view.text()).toContain("Retry");
    expect(view.text()).not.toContain("Open on GitHub");
  });

  it("renders no action content without a retry or browser target", async () => {
    const view = await renderDom(
      <PullRequestsUnavailableState error="This project has no known remote." />,
    );

    expect(view.find('[data-slot="empty-content"]')).toBeNull();
    expect(view.findAll("[href]")).toHaveLength(0);
  });

  // The retry is the whole point of keeping it in this state, and a button that renders but is
  // not wired to the caller looks identical in markup to one that is.
  it("asks the caller to load again when the retry is pressed", async () => {
    const onRetry = vi.fn();
    const view = await renderDom(
      <PullRequestsUnavailableState error="GitHub did not answer." onRetry={onRetry} />,
    );

    await view.click(
      view.findAll<HTMLButtonElement>("button").find((button) => button.textContent === "Retry") ??
        null,
    );

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

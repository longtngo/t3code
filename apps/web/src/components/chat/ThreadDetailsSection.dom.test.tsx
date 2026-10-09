import { beforeEach, describe, expect, it } from "vite-plus/test";
import { renderDom } from "../../testing/renderDom";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const section = (collapseKey?: "tasks" | "lineage") => (
  <ThreadDetailsSection
    headingId="h"
    title="Tasks · 1/3"
    collapseKey={collapseKey}
    actions={<span data-action>chip</span>}
  >
    <div data-body>rows</div>
  </ThreadDetailsSection>
);
const toggle = (view: Awaited<ReturnType<typeof renderDom>>) =>
  view.findAll("button").find((b) => b.hasAttribute("aria-expanded")) ?? null;

describe("ThreadDetailsSection", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("folds its rows and keeps the header actions", async () => {
    const view = await renderDom(section("tasks"));
    expect(view.container.querySelector("[data-body]")).not.toBeNull();
    await view.click(toggle(view));
    expect(view.container.querySelector("[data-body]")).toBeNull();
    expect(view.container.querySelector("[data-action]")).not.toBeNull();
    expect(toggle(view)?.getAttribute("aria-expanded")).toBe("false");
    await view.click(toggle(view));
    expect(view.container.querySelector("[data-body]")).not.toBeNull();
  });

  it("stays folded for the next thread, per section", async () => {
    const first = await renderDom(section("tasks"));
    await first.click(toggle(first));
    const nextThread = await renderDom(section("tasks"));
    expect(nextThread.container.querySelector("[data-body]")).toBeNull();
    const lineage = await renderDom(section("lineage"));
    expect(lineage.container.querySelector("[data-body]")).not.toBeNull();
  });

  it("has no toggle without a collapse key", async () => {
    const view = await renderDom(section());
    expect(toggle(view)).toBeNull();
    expect(view.container.querySelector("[data-body]")).not.toBeNull();
  });
});

import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { renderDom } from "../../testing/renderDom";

let limit = 6;
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (s: { threadDetailsSectionRowLimit: number }) => T) =>
    selector({ threadDetailsSectionRowLimit: limit }),
}));
const { ThreadDetailsRowGroup } = await import("./ThreadDetailsRowGroup");

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${i}`);
const group = (n: number, extra: Partial<{ label: string; minVisible: number }> = {}) => (
  <ThreadDetailsRowGroup<string> rows={rows(n)} {...extra}>
    {(visible) =>
      visible.map((r) => (
        <div key={r} data-row={r}>
          {r}
        </div>
      ))
    }
  </ThreadDetailsRowGroup>
);
const count = (root: ParentNode) => root.querySelectorAll("[data-row]").length;
const button = (view: Awaited<ReturnType<typeof renderDom>>, text: string) =>
  view.findAll("button").find((b) => b.textContent?.includes(text)) ?? null;

describe("ThreadDetailsRowGroup", () => {
  beforeEach(() => {
    limit = 6;
  });
  it("shows the limit, then pages twelve at a time", async () => {
    const view = await renderDom(group(20));
    expect(count(view.container)).toBe(6);
    expect(view.text()).toContain("Show 12 more");
    await view.click(button(view, "Show 12 more"));
    expect(count(view.container)).toBe(18);
    expect(view.text()).toContain("Show 2 more");
  });
  it("hides Show more when everything fits", async () => {
    const view = await renderDom(group(6));
    expect(count(view.container)).toBe(6);
    expect(view.text()).not.toContain("more");
  });
  it("honours limits 1 and 50", async () => {
    limit = 1;
    expect(count((await renderDom(group(3))).container)).toBe(1);
    limit = 50;
    expect(count((await renderDom(group(60))).container)).toBe(50);
  });
  it("re-windows an open list when the setting changes", async () => {
    const view = await renderDom(group(40));
    await view.click(button(view, "Show 12 more"));
    expect(count(view.container)).toBe(18);
    limit = 10;
    await view.rerender(group(40));
    expect(count(view.container)).toBe(22);
  });
  it("shows at least minVisible rows past the limit", async () => {
    const view = await renderDom(group(9, { minVisible: 8 }));
    expect(count(view.container)).toBe(8);
    expect(view.text()).toContain("Show 1 more");
  });
  it("one Show more click past minVisible reveals a full page", async () => {
    const view = await renderDom(group(30, { minVisible: 20 }));
    expect(count(view.container)).toBe(20);
    expect(view.text()).toContain("Show 10 more");
    await view.click(button(view, "Show 10 more"));
    expect(count(view.container)).toBe(30);
  });
  it("ignores a minVisible below the limit", async () => {
    const view = await renderDom(group(9, { minVisible: 3 }));
    expect(count(view.container)).toBe(6);
    expect(view.text()).toContain("Show 3 more");
  });
  it("renders nothing for no rows", async () => {
    expect((await renderDom(group(0))).container.innerHTML).toBe("");
  });
  it("folds behind its label with a count", async () => {
    const view = await renderDom(group(3, { label: "Previous task lists" }));
    expect(count(view.container)).toBe(0);
    expect(view.text()).toContain("Previous task lists (3)");
    await view.click(button(view, "Previous task lists"));
    expect(count(view.container)).toBe(3);
  });
});

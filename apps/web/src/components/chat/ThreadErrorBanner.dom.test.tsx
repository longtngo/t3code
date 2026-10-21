import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  getThreadErrorBannerMessage,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("getThreadErrorBannerMessage", () => {
  it("extracts a readable nested message without trimming its whitespace", () => {
    const message =
      "  This model is not supported with a ChatGPT account.\nChoose another model.  ";
    const error = ` \n${JSON.stringify({ error: { message, code: "unsupported_model" } })}\t `;

    expect(getThreadErrorBannerMessage(error)).toBe(message);
  });

  it("keeps the diagnostics when the nested message is blank", () => {
    const error = JSON.stringify({ error: { message: " \n\t ", code: "unsupported_model" } });

    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });
});

describe("ThreadErrorBanner", () => {
  it("reappears for different diagnostics with the same headline on the same thread", () => {
    const firstError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const secondError = JSON.stringify({ error: { message: "Turn failed", code: "second" } });
    const dismissedKey = getThreadErrorBannerKey("env:thread-b", firstError);
    dismissThreadErrorBannerForSession(dismissedKey);
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", secondError);

    expect(isThreadErrorBannerDismissedForSession(dismissedKey)).toBe(true);
    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        secondError,
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("aligns the warning and dismiss icons with the first line of a multi-line error", async () => {
    const view = await renderDom(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    const alert = view.find('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(view.find('[aria-label="Dismiss error"]')).not.toBeNull();
    // `controlAlignment` is an `Alert` prop, not an attribute: leaking it would show up as a
    // lowercased attribute on the rendered element.
    expect(view.find("[controlalignment]")).toBeNull();

    const row = alert?.firstElementChild;
    expect([...(row?.classList ?? [])]).toEqual(
      expect.arrayContaining([
        "flex",
        "gap-2",
        "items-start",
        "min-h-7",
        "pt-1",
        "sm:min-h-6",
        "sm:pt-0.5",
      ]),
    );

    const iconSlot = row?.firstElementChild;
    expect([...(iconSlot?.classList ?? [])]).toEqual(expect.arrayContaining(["h-lh", "w-4"]));

    const actionSlot = row?.lastElementChild;
    expect([...(actionSlot?.classList ?? [])]).toEqual(
      expect.arrayContaining(["h-lh", "self-start"]),
    );
  });

  it("shows the error text and dismisses on the dismiss button", async () => {
    const onDismiss = vi.fn();
    const view = await renderDom(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={onDismiss}
      />,
    );

    expect(view.text()).toContain("The first error line");

    await view.click(view.find('[aria-label="Dismiss error"]'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without an error, and no dismiss control without a handler", async () => {
    const view = await renderDom(<ThreadErrorBanner error={null} onDismiss={() => {}} />);
    expect(view.find('[role="alert"]')).toBeNull();

    await view.rerender(<ThreadErrorBanner error="Aborted" />);
    expect(view.find('[role="alert"]')).not.toBeNull();
    expect(view.find('[aria-label="Dismiss error"]')).toBeNull();
  });
});

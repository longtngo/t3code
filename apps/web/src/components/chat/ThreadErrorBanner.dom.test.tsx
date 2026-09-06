import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(
      shouldShowThreadErrorBanner(
        "env:thread-a",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-b", "Turn failed"));
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-c", "Aborted"));
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:other-thread",
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner("env:thread-d", null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-d",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread-e", null, false)).toBe(false);
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

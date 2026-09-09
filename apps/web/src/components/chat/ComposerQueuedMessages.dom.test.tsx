import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerQueuedBadge, ComposerQueuedDrawer } from "./ComposerQueuedMessages";

/**
 * `ComposerBanner.Dock` hides itself unless something inside it carries an
 * attached banner surface (`not-has-data-[composer-banner-surface=attached]:hidden`).
 * A dock child that renders without one is therefore invisible whenever it is
 * the only thing docked — which is the normal case for the queued badge.
 */
function renderDocked(child: ReturnType<typeof createElement>) {
  return renderDom(
    createElement(ComposerBanner.Dock, null, createElement(ComposerBanner.Column, null, child)),
  );
}

describe("ComposerQueuedMessages in the composer dock", () => {
  it("the collapsed badge carries an attached surface so the dock stays visible", async () => {
    const view = await renderDocked(
      createElement(
        ComposerBanner.Attachment,
        null,
        createElement(ComposerQueuedBadge, { count: 1, onToggle: () => {} }),
      ),
    );
    const badge = view.find('button[data-chat-composer-queued-badge="true"]');
    expect(badge?.getAttribute("aria-label")).toBe("1 message waiting to send");
    expect(badge?.closest('[data-composer-banner-surface="attached"]')).not.toBeNull();
  });

  it("the open drawer carries an attached surface so the dock stays visible", async () => {
    const view = await renderDocked(
      createElement(ComposerQueuedDrawer, {
        messages: [{ id: "m1", text: "hello", attachmentCount: 0 }],
        onCollapse: () => {},
        onRecall: async () => null,
        recallPendingId: null,
        recallSupported: false,
      }),
    );
    const drawer = view.find('[data-chat-composer-queued-drawer="true"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.closest('[data-composer-banner-surface="attached"]')).not.toBeNull();
  });
});

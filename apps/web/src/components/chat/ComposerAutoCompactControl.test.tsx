import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerAutoCompactControl } from "./ComposerAutoCompactControl";

function render(props: { armed: boolean; status: string | null; paused?: boolean }) {
  return renderToStaticMarkup(
    createElement(ComposerAutoCompactControl, {
      paused: false,
      ...props,
      onDisarm: () => {},
    }),
  );
}

describe("ComposerAutoCompactControl", () => {
  // The whole point of moving off the banner is that a thread nobody armed costs no chrome.
  // Asserted as an absence, with the armed case beside it so an always-null render cannot
  // satisfy this on its own.
  it("renders nothing for a thread that is not armed", () => {
    expect(render({ armed: false, status: "Will compact at 50%" })).toBe("");
    expect(render({ armed: true, status: "Will compact at 50%" })).not.toBe("");
  });

  // Asserted on the accessible name rather than the tooltip on purpose: the tooltip popup is
  // portalled, so it is absent from a static render AND from every touch device. If the status
  // only lived there, the mobile web view would show an armed thread with no way to read why.
  it("carries the status in its accessible name, not only the tooltip", () => {
    expect(render({ armed: true, status: "Will compact at 50%" })).toContain(
      'aria-label="Will compact at 50%. Click to turn it off."',
    );
  });

  // A thread can be armed before any usage snapshot arrives, so the control has to say
  // something true with no status to show.
  it("still reads as on when there is no status yet", () => {
    expect(render({ armed: true, status: null })).toContain(
      'aria-label="Auto-compact is on. Click to turn it off."',
    );
  });

  // Removing the banner took away the only visible sign that the sequence had stopped, so a
  // paused thread has to be distinguishable from a working one without hovering. Asserted with
  // its negative, since a control that always looked paused would satisfy the positive alone.
  it("looks different once the sequence has stopped", () => {
    const paused = render({ armed: true, status: "Paused after 3 rounds", paused: true });
    const running = render({ armed: true, status: "Will compact at 50%", paused: false });
    expect(paused).toContain('data-auto-compact-paused="true"');
    expect(running).toContain('data-auto-compact-paused="false"');
    expect(paused).toContain("amber");
    expect(running).not.toContain("amber");
  });
});

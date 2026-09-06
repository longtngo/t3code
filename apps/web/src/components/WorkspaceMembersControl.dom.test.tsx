import type { WorkspaceMember } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { describe, expect, it } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";
import WorkspaceMembersControl from "./WorkspaceMembersControl";

function member(id: string, title: string): WorkspaceMember {
  return { id, title, path: `/Users/dev/${title}`, integrationBranch: "main" };
}

/**
 * Holds each write open so the next interaction lands before the server echoes.
 *
 * That window is not hypothetical: the dispatch RPC acks straight from
 * `dispatchNormalizedCommand`, while the `members` prop is only refreshed by the
 * shell stream, which the server coalesces on a 50ms window. Every real write has
 * a gap where the ack has returned and the prop is still the pre-write list.
 */
function harness() {
  const writes: Array<ReadonlyArray<WorkspaceMember>> = [];
  const resolvers: Array<(succeeded: boolean) => void> = [];
  const onMembersChange = (next: ReadonlyArray<WorkspaceMember>) => {
    writes.push(next);
    return new Promise<boolean>((resolve) => resolvers.push(resolve));
  };
  return {
    writes,
    onMembersChange,
    /** Ack the write without echoing it back, exactly as the server does. */
    ack: (index: number, succeeded = true) => resolvers[index]?.(succeeded),
    titles: () => writes.at(-1)?.map((entry) => entry.title) ?? null,
  };
}

const titlesOf = (members: ReadonlyArray<WorkspaceMember>) => members.map((m) => m.title);

// React tracks the previous value on the DOM node, so a plain `input.value = x`
// is swallowed. Same shape as DiffCommentAnnotation.dom.test.tsx.
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.bind(
    input,
  );
  await act(async () => {
    setValue?.(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("WorkspaceMembersControl concurrent writes", () => {
  it("does not resurrect the first detach when a second lands before the echo", async () => {
    const members = [member("m-web", "web"), member("m-api", "api")];
    const h = harness();
    const control = (
      <WorkspaceMembersControl
        environmentId={EnvironmentId.make("local")}
        members={members}
        onMembersChange={h.onMembersChange}
      />
    );
    const dom = await renderDom(control);

    await dom.click(dom.find('[aria-label="Detach web"]'));
    h.ack(0);
    await dom.rerender(control);
    await dom.click(dom.find('[aria-label="Detach api"]'));

    // The outcome, not the strategy: however many writes it takes, the last list
    // the server is asked to store must contain neither repository. Asserting a
    // write COUNT here would fail a correct implementation that issues two.
    expect(h.titles()).toEqual([]);
  });

  it("does not resurrect a detach when an attach lands before the echo", async () => {
    const members = [member("m-web", "web")];
    const h = harness();
    const control = (
      <WorkspaceMembersControl
        environmentId={EnvironmentId.make("local")}
        members={members}
        onMembersChange={h.onMembersChange}
      />
    );
    const dom = await renderDom(control);

    await dom.click(dom.find('[aria-label="Detach web"]'));
    h.ack(0);
    await dom.rerender(control);

    const path = dom.find<HTMLInputElement>('input[placeholder="~/src/uni/prm_portal_api"]');
    const branch = dom.find<HTMLInputElement>('input[placeholder="pickup-v2"]');
    if (!path || !branch) throw new Error("editor fields not found");
    await typeInto(path, "/Users/dev/api");
    await typeInto(branch, "main");
    await dom.click(
      dom.findAll("button").find((b) => b.textContent?.trim() === "Attach repository") ?? null,
    );

    // The attach is computed from the post-detach list, so "web" stays gone.
    expect(h.titles()).toEqual(["api"]);
  });

  it("falls back to the server's list when a write fails", async () => {
    const members = [member("m-web", "web"), member("m-api", "api")];
    const h = harness();
    const control = (
      <WorkspaceMembersControl
        environmentId={EnvironmentId.make("local")}
        members={members}
        onMembersChange={h.onMembersChange}
      />
    );
    const dom = await renderDom(control);

    await dom.click(dom.find('[aria-label="Detach web"]'));
    h.ack(0, false);
    await dom.rerender(control);

    // The write was refused, so the row must come back rather than stay
    // optimistically hidden with nothing to recover it from.
    expect(dom.text()).toContain("web");
    await dom.click(dom.find('[aria-label="Detach api"]'));
    expect(h.titles()).toEqual(titlesOf([member("m-web", "web")]));
  });

  it("does not lose an attach when a detach lands before the echo", async () => {
    // The mirror of the test above, and the one that catches `handleSubmit`
    // bypassing the shared write path: there the attach is not recorded, so the
    // detach that follows is computed from the pre-attach list and drops it.
    const members = [member("m-web", "web")];
    const h = harness();
    const control = (
      <WorkspaceMembersControl
        environmentId={EnvironmentId.make("local")}
        members={members}
        onMembersChange={h.onMembersChange}
      />
    );
    const dom = await renderDom(control);

    const path = dom.find<HTMLInputElement>('input[placeholder="~/src/uni/prm_portal_api"]');
    const branch = dom.find<HTMLInputElement>('input[placeholder="pickup-v2"]');
    if (!path || !branch) throw new Error("editor fields not found");
    await typeInto(path, "/Users/dev/api");
    await typeInto(branch, "main");
    await dom.click(
      dom.findAll("button").find((b) => b.textContent?.trim() === "Attach repository") ?? null,
    );
    h.ack(0);
    await dom.rerender(control);

    await dom.click(dom.find('[aria-label="Detach web"]'));

    expect(h.titles()).toEqual(["api"]);
  });

  it("does not strand the optimistic list when a write rejects", async () => {
    const members = [member("m-web", "web")];
    const dom = await renderDom(
      <WorkspaceMembersControl
        environmentId={EnvironmentId.make("local")}
        members={members}
        onMembersChange={() => Promise.reject(new Error("boom"))}
      />,
    );

    await dom.click(dom.find('[aria-label="Detach web"]'));

    // Showing a repository as detached when the write never landed is worse than
    // showing it still attached: nothing corrects it until the next echo.
    expect(dom.text()).toContain("web");
  });

  it("survives an unrelated project update arriving mid-write", async () => {
    // `projectAtomFamily` rebuilds the project on every `project-upserted` for it,
    // so a rename from another device hands this control an equal-content but
    // new-identity `members` array while our write is still in flight. Dropping
    // the submitted list on identity would restore the stale one and undo it.
    const members = [member("m-web", "web"), member("m-api", "api")];
    const h = harness();
    const props = {
      environmentId: EnvironmentId.make("local"),
      onMembersChange: h.onMembersChange,
    };
    const dom = await renderDom(<WorkspaceMembersControl {...props} members={members} />);

    await dom.click(dom.find('[aria-label="Detach web"]'));
    h.ack(0);
    // Same contents, fresh array — the shape the atom family produces.
    await dom.rerender(
      <WorkspaceMembersControl {...props} members={members.map((entry) => ({ ...entry }))} />,
    );
    await dom.click(dom.find('[aria-label="Detach api"]'));

    expect(h.titles()).toEqual([]);
  });

  it("ignores the echo of an earlier write while a newer one is in flight", async () => {
    // Two detaches, then the FIRST one's echo arrives. It is older than what is in
    // flight, so adopting it would flash the second detached row back and have the
    // next click computed from the pre-second-write list, undoing it.
    const members = [member("m-web", "web"), member("m-api", "api"), member("m-doc", "doc")];
    const h = harness();
    const props = {
      environmentId: EnvironmentId.make("local"),
      onMembersChange: h.onMembersChange,
    };
    const dom = await renderDom(<WorkspaceMembersControl {...props} members={members} />);

    await dom.click(dom.find('[aria-label="Detach web"]'));
    await dom.click(dom.find('[aria-label="Detach api"]'));
    h.ack(0);
    await dom.rerender(
      <WorkspaceMembersControl
        {...props}
        members={[member("m-api", "api"), member("m-doc", "doc")]}
      />,
    );

    expect(dom.text()).not.toContain("api");
    await dom.click(dom.find('[aria-label="Detach doc"]'));
    expect(h.titles()).toEqual([]);
  });

  it("renders the optimistic list, not just an emptied one", async () => {
    // Guards the rows specifically: an implementation that renders `members` while
    // computing writes from the pending list passes every other test here, because
    // the empty-state branch masks it whenever the list ends up empty.
    const members = [member("m-web", "web"), member("m-api", "api")];
    const h = harness();
    const dom = await renderDom(
      <WorkspaceMembersControl
        environmentId={EnvironmentId.make("local")}
        members={members}
        onMembersChange={h.onMembersChange}
      />,
    );

    await dom.click(dom.find('[aria-label="Detach web"]'));

    expect(dom.text()).not.toContain("web");
    expect(dom.text()).toContain("api");
  });

  it("lets a just-detached repository be re-attached before the echo", async () => {
    // The editor validates against the list it is given. Handing it the server's
    // list would refuse this with "already attached" for a repository the user can
    // plainly see is gone.
    const members = [member("m-web", "web")];
    const h = harness();
    const dom = await renderDom(
      <WorkspaceMembersControl
        environmentId={EnvironmentId.make("local")}
        members={members}
        onMembersChange={h.onMembersChange}
      />,
    );

    await dom.click(dom.find('[aria-label="Detach web"]'));
    const path = dom.find<HTMLInputElement>('input[placeholder="~/src/uni/prm_portal_api"]');
    const branch = dom.find<HTMLInputElement>('input[placeholder="pickup-v2"]');
    if (!path || !branch) throw new Error("editor fields not found");
    await typeInto(path, "/Users/dev/web");
    await typeInto(branch, "main");
    await dom.click(
      dom.findAll("button").find((b) => b.textContent?.trim() === "Attach repository") ?? null,
    );

    expect(dom.text()).not.toContain("already attached");
    expect(h.titles()).toEqual(["web"]);
  });

  it("adopts the server's list once it echoes", async () => {
    const members = [member("m-web", "web")];
    const h = harness();
    const props = {
      environmentId: EnvironmentId.make("local"),
      onMembersChange: h.onMembersChange,
    };
    const dom = await renderDom(<WorkspaceMembersControl {...props} members={members} />);

    await dom.click(dom.find('[aria-label="Detach web"]'));
    h.ack(0);

    // A different machine attached something while our write was in flight. Once
    // the prop changes the optimistic list must be dropped, or the control would
    // render its own stale copy forever and never show anyone else's changes.
    const echoed = [member("m-docs", "docs")];
    await dom.rerender(<WorkspaceMembersControl {...props} members={echoed} />);

    expect(dom.text()).toContain("docs");
  });

  it("keeps the newer write when an older one fails", async () => {
    const members = [member("m-web", "web"), member("m-api", "api")];
    const h = harness();
    const control = (
      <WorkspaceMembersControl
        environmentId={EnvironmentId.make("local")}
        members={members}
        onMembersChange={h.onMembersChange}
      />
    );
    const dom = await renderDom(control);

    await dom.click(dom.find('[aria-label="Detach web"]'));
    await dom.rerender(control);
    await dom.click(dom.find('[aria-label="Detach api"]'));
    // The FIRST write now fails, after the second has already superseded it.
    h.ack(0, false);
    await dom.rerender(control);

    // Retracting to the server list here would resurrect both rows and throw away
    // the second write, which is still in flight and may well succeed.
    expect(dom.text()).not.toContain("web");
  });
});

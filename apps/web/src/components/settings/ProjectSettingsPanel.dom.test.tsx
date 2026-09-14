import type { WorkspaceMember } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { createContext, use } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

// The panel resolves its group through `buildSidebarProjectSnapshots`, so stubbing that one
// function supplies the whole fixture without also mocking projects, environments and settings.
// The router and the atom-command dispatcher have no test doubles in this app. `ui/select` is
// replaced by a native `<select>` because the real one renders its options through a portal,
// outside the container this harness queries - and switching checkout is exactly what these
// tests need to do. Everything under test - the row, `WorkspaceMembersControl` and its editor -
// is real.
const dispatched: Array<unknown> = [];

// The real Select drives selection through a portalled listbox this harness cannot reach, and
// routing the mock through a native `<select>` runs into React's value tracking. Carrying the
// callback on a context and letting each item invoke it keeps the interaction real without either.
const SelectChoiceContext = createContext<((next: string) => void) | null>(null);

vi.mock("../../sidebarProjectGrouping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sidebarProjectGrouping")>()),
  buildSidebarProjectSnapshots: () => [group],
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
  useCanGoBack: () => false,
  useLocation: ({ select }: { select?: (location: unknown) => unknown } = {}) => {
    const location = { hash: "", state: {} };
    return select ? select(location) : location;
  },
  Link: ({ children }: { readonly children?: ReactNode }) => children,
}));

let nextResult:
  | { _tag: "Success"; value: undefined }
  | { _tag: "Failure"; cause: Cause.Cause<unknown> } = { _tag: "Success", value: undefined };

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => (input: unknown) => {
    dispatched.push(input);
    return Promise.resolve(nextResult);
  },
}));

vi.mock("../ui/select", () => {
  const Passthrough = ({ children }: { readonly children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({
      onValueChange,
      children,
    }: {
      readonly onValueChange: (next: string) => void;
      readonly children?: ReactNode;
    }) => <SelectChoiceContext value={onValueChange}>{children}</SelectChoiceContext>,
    SelectTrigger: () => null,
    SelectValue: Passthrough,
    SelectPopup: Passthrough,
    SelectItem: ({
      value,
      children,
    }: {
      readonly value: string;
      readonly children?: ReactNode;
    }) => {
      const onValueChange = use(SelectChoiceContext);
      return (
        <button aria-label={`Choose ${value}`} onClick={() => onValueChange?.(value)} type="button">
          {children}
        </button>
      );
    },
  };
});

function makeMember(id: string, title: string): WorkspaceMember {
  return { id, title, path: `/Users/dev/${title}`, integrationBranch: "main" };
}

const localCheckout = {
  id: "proj-local",
  environmentId: "local",
  physicalProjectKey: "local:proj-local",
  environmentLabel: null,
  title: "web",
  members: [makeMember("m-api", "api")],
  scripts: [],
  workspaceRoot: "/Users/dev/web",
};

// A second checkout of the same project, in another environment, with its own repositories.
// Without this the representative and the selected checkout are the same object and every
// assertion about per-checkout scoping is vacuous.
const remoteCheckout = {
  ...localCheckout,
  id: "proj-remote",
  environmentId: "remote",
  physicalProjectKey: "remote:proj-remote",
  environmentLabel: "Workstation",
  members: [makeMember("m-docs", "docs")],
  workspaceRoot: "/srv/web",
};

const group = {
  ...localCheckout,
  projectKey: "group-1",
  displayName: "web",
  groupedProjectCount: 2,
  memberProjects: [localCheckout, remoteCheckout],
  memberProjectRefs: [
    { environmentId: "local", projectId: "proj-local" },
    { environmentId: "remote", projectId: "proj-remote" },
  ],
  remoteEnvironmentLabels: ["Workstation"],
  allRemoteMembersAreDesktopLocal: false,
};

async function mountPanel() {
  dispatched.length = 0;
  nextResult = { _tag: "Success", value: undefined };
  const { ProjectSettingsPanel } = await import("./ProjectSettingsPanel");
  const { SettingsScopeProvider } = await import("./SettingsScopeContext");
  // Upstream's per-project scoped settings put `ProjectActionsSettings` behind
  // `useSettingsScope`, which throws outside the provider. The panel itself does
  // not read the scope; its children do.
  return renderDom(
    <SettingsScopeProvider search={{ project: "group-1" }} onChange={() => {}}>
      <ProjectSettingsPanel projectKey="group-1" />
    </SettingsScopeProvider>,
  );
}

describe("ProjectSettingsPanel workspace repositories", () => {
  it("gives each checkout its own repositories, not the group representative's", async () => {
    const dom = await mountPanel();

    // One row per checkout, each listing its OWN members. Passing the group
    // representative's list to every row shows "api" twice and "docs" never.
    expect(dom.findAll('[aria-label="Edit api"]')).toHaveLength(1);
    expect(dom.findAll('[aria-label="Edit docs"]')).toHaveLength(1);
  });

  it("detaching writes the shortened list to that checkout, not to the group", async () => {
    const dom = await mountPanel();

    await dom.click(dom.find('[aria-label="Detach docs"]'));

    // The payload is the assertion: the checkout the member belongs to, and the member actually
    // removed. Scoping the row to the representative sends `proj-local`; fanning the write out
    // over the group sends two.
    expect(dispatched).toEqual([
      { environmentId: "remote", input: { projectId: "proj-remote", members: [] } },
    ]);
  });

  it("keeps each checkout's editor state to itself", async () => {
    const dom = await mountPanel();

    await dom.click(dom.find('[aria-label="Edit api"]'));

    // Exactly one editor, in the checkout whose member was clicked. A shared
    // `editingId` - or both rows fed the same member list - opens two.
    expect(
      dom.findAll("button").filter((button) => button.textContent?.trim() === "Save changes"),
    ).toHaveLength(1);
    expect(dom.find('[aria-label="Edit docs"]')).not.toBeNull();
  });

  it("keeps the editor open when a save fails, and closes it when one succeeds", async () => {
    const dom = await mountPanel();
    const save = () =>
      dom.findAll("button").find((button) => button.textContent?.trim() === "Save changes") ?? null;

    await dom.click(dom.find('[aria-label="Edit api"]'));
    // A real Cause, not a bare error: `isAtomCommandInterrupted` inspects it to decide whether to
    // stay silent, so a hand-rolled object crashes the reporter instead of exercising it.
    nextResult = { _tag: "Failure", cause: Cause.fail(new Error("nope")) };
    await dom.click(save());

    // Clearing the editor on a failed write would discard what the user typed. Only Save honours
    // the boolean - Detach clears `editingId` before it dispatches, either way.
    expect(save()).not.toBeNull();

    nextResult = { _tag: "Success", value: undefined };
    await dom.click(save());
    expect(save()).toBeNull();
  });
});

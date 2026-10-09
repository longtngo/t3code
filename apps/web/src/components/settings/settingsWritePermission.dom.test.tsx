import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

type Grant = AsyncResult.AsyncResult<AuthSessionState, unknown>;

const fixture = vi.hoisted(() => ({ grant: null as unknown }));

// The real denial rule over the fixture's grant; everything else is the real component.
vi.mock("../../state/session", async (importOriginal) => {
  const { sessionResultDeniesScope } = await import("@t3tools/client-runtime/state/sessionScope");
  return {
    ...(await importOriginal<typeof import("../../state/session")>()),
    useEnvironmentScopeDenied: (_id: unknown, scope: never) =>
      sessionResultDeniesScope(fixture.grant as Grant, scope),
  };
});
// The base-ui tooltip needs a provider this harness does not mount.
vi.mock("../ui/tooltip", () => {
  const Pass = ({ children }: { readonly children?: ReactNode }) => <>{children}</>;
  return {
    Tooltip: Pass,
    TooltipPopup: Pass,
    TooltipTrigger: ({ render }: { readonly render: ReactNode }) => <>{render}</>,
  };
});

import { CursorEnableButton } from "../usage/UsagePage";
import { BitbucketCredentialsSettings } from "./BitbucketCredentialsSettings";
import { GitHubAccountSettings } from "./GitHubAccountSettings";
import { GitHubTokenSettings } from "./GitHubTokenSettings";

const SENTENCE = "This connection does not have permission to change environment settings.";
const environmentId = EnvironmentId.make("env-1");

const session = (permissions: readonly string[]): Grant =>
  AsyncResult.success({ authenticated: true, scopes: [], permissions } as never);
// Paired before the permission split: no `settings:write`.
const legacy = session(["orchestration:read", "orchestration:operate"]);

const controls: ReadonlyArray<readonly [string, () => ReactNode, string]> = [
  [
    "GitHub token",
    () => <GitHubTokenSettings environmentId={environmentId} onSaved={() => {}} />,
    "#github-token-env-1",
  ],
  [
    "GitHub accounts",
    () => (
      <GitHubAccountSettings
        environmentId={environmentId}
        onSaved={() => {}}
        auth={
          {
            status: "authenticated",
            accounts: [{ host: "github.com", account: "dev", active: true, authenticated: true }],
          } as never
        }
      />
    ),
    '[aria-label="Use GitHub on github.com"]',
  ],
  [
    "Bitbucket credentials",
    () => <BitbucketCredentialsSettings environmentId={environmentId} onSaved={() => {}} />,
    "#bitbucket-access-token-env-1",
  ],
];

beforeEach(() => {
  fixture.grant = legacy;
});

describe("settings saves under a login without settings:write", () => {
  it.each(controls)("%s is disabled and says why", async (_name, render, selector) => {
    const dom = await renderDom(render());
    expect(dom.text()).toContain(SENTENCE);
    const control = dom.find<HTMLInputElement | HTMLButtonElement>(selector);
    expect(control).not.toBeNull();
    // Disabled itself, or by the fieldset around it (happy-dom does not apply `:disabled` there).
    const disabled =
      control?.matches(":disabled") ||
      control?.hasAttribute("data-disabled") ||
      control?.closest("fieldset")?.disabled;
    expect(disabled).toBe(true);
  });

  it.each(controls)("%s stays editable while the grant is still loading", async (_n, render) => {
    fixture.grant = AsyncResult.initial(true);
    const dom = await renderDom(render());
    expect(dom.text()).not.toContain(SENTENCE);
  });

  it("GitHub account choice is disabled for a host with several logins", async () => {
    const accounts = [
      { host: "github.com", account: "dev", active: true, authenticated: true },
      { host: "github.com", account: "bot", active: false, authenticated: true },
    ];
    const dom = await renderDom(
      <GitHubAccountSettings
        environmentId={environmentId}
        onSaved={() => {}}
        auth={{ status: "authenticated", accounts } as never}
      />,
    );
    const trigger = dom.find('[aria-label="GitHub account for github.com"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.matches(":disabled") || trigger?.hasAttribute("data-disabled")).toBe(true);
  });

  it("Cursor usage offers no enable button, only the reason", async () => {
    const dom = await renderDom(
      <CursorEnableButton
        environmentId={environmentId}
        label="Laptop"
        onEnabled={() => {}}
        tooltip
      />,
    );
    expect(dom.text()).toContain(SENTENCE);
    expect(dom.find('[aria-label="Enable Cursor usage from Laptop"]')).toBeNull();

    fixture.grant = session(["settings:write"]);
    const granted = await renderDom(
      <CursorEnableButton
        environmentId={environmentId}
        label="Laptop"
        onEnabled={() => {}}
        tooltip
      />,
    );
    expect(granted.find('[aria-label="Enable Cursor usage from Laptop"]')).not.toBeNull();
  });
});

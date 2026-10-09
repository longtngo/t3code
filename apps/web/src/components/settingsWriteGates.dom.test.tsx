import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { RemoteEnvironmentAuthTimeoutError } from "@t3tools/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";

/**
 * Every control gated on `settings:write`, under four logins. Only a loaded grant without the
 * scope (legacy) disables a control and states the reason; a granted login, one still loading and
 * one offline with a cached grant keep it enabled and silent. Adapted from a review probe.
 */
type Grant = AsyncResult.AsyncResult<AuthSessionState, unknown>;
const fixture = vi.hoisted(() => ({ grant: null as unknown }));

// Every grant check reads the fixture through the real rules.
vi.mock("~/state/session", async (importOriginal) => {
  const { sessionResultDeniesScope, sessionResultGrantsScope } =
    await import("@t3tools/client-runtime/state/sessionScope");
  const grants = (_id: unknown, scope: never) =>
    sessionResultGrantsScope(fixture.grant as Grant, scope);
  const denied = (_id: unknown, scope: never) =>
    sessionResultDeniesScope(fixture.grant as Grant, scope);
  return {
    ...(await importOriginal<typeof import("~/state/session")>()),
    readEnvironmentScope: grants,
    useEnvironmentScope: grants,
    readEnvironmentScopeDenied: denied,
    useEnvironmentScopeDenied: denied,
  };
});
// The base-ui tooltip needs a provider this harness does not mount.
vi.mock("./ui/tooltip", async () => {
  const { cloneElement } = await import("react");
  const Pass = ({ children }: { readonly children?: ReactNode }) => <>{children}</>;
  return {
    Tooltip: Pass,
    TooltipPopup: () => null,
    TooltipTrigger: ({
      render,
      children,
    }: {
      readonly render: ReactElement<{ children?: ReactNode }>;
      readonly children?: ReactNode;
    }) => cloneElement(render, {}, children),
  };
});

import ProjectScriptsControl from "./ProjectScriptsControl";
import { BitbucketCredentialsSettings } from "./settings/BitbucketCredentialsSettings";
import { GitHubAccountSettings } from "./settings/GitHubAccountSettings";
import { GitHubTokenSettings } from "./settings/GitHubTokenSettings";
import { CursorEnableButton } from "./usage/UsagePage";

const SENTENCE = "This connection does not have permission to change environment settings.";
const env = EnvironmentId.make("env-1");
const everything = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "filesystem:read",
];
const answered = (permissions: readonly string[]) =>
  AsyncResult.success({ authenticated: true, scopes: [], permissions } as never) as Grant;

const logins: ReadonlyArray<readonly [string, Grant, boolean]> = [
  ["granted", answered(everything), false],
  ["loading", AsyncResult.initial(true) as Grant, false],
  [
    "offline with a cached grant",
    AsyncResult.failure(
      Cause.fail(new RemoteEnvironmentAuthTimeoutError("https://env.test", 6_000)),
      { previousSuccess: Option.some(answered(everything) as never) },
    ) as Grant,
    false,
  ],
  // Paired before the permission split: no `settings:write`.
  ["legacy", answered(["orchestration:read", "orchestration:operate"]), true],
];

const isDisabled = (element: Element | null) =>
  element !== null &&
  (element.matches(":disabled") ||
    element.hasAttribute("data-disabled") ||
    // happy-dom does not apply `:disabled` inside a disabled fieldset.
    element.closest("fieldset")?.disabled === true);
const sentenceCount = () => (document.body.textContent ?? "").split(SENTENCE).length - 1;

const projectActions = (onAddScript: () => Promise<unknown>, withFileScript: boolean) => (
  <ProjectScriptsControl
    environmentId={env}
    scripts={[]}
    fileScripts={withFileScript ? [{ name: "Lint", command: "vp lint" }] : []}
    onAddScript={onAddScript as never}
    onUpdateScript={vi.fn()}
    onDeleteScript={vi.fn()}
  />
);

describe.each(logins)("settings write gates, %s login", (_name, grant, denied) => {
  it("GitHub token", async () => {
    fixture.grant = grant;
    const dom = await renderDom(<GitHubTokenSettings environmentId={env} onSaved={() => {}} />);
    expect(isDisabled(dom.find("#github-token-env-1"))).toBe(denied);
    expect(dom.text().includes(SENTENCE)).toBe(denied);
  });

  it("Bitbucket credentials", async () => {
    fixture.grant = grant;
    const dom = await renderDom(
      <BitbucketCredentialsSettings environmentId={env} onSaved={() => {}} />,
    );
    expect(isDisabled(dom.find("#bitbucket-access-token-env-1"))).toBe(denied);
    expect(dom.text().includes(SENTENCE)).toBe(denied);
  });

  it("GitHub host and account choice", async () => {
    fixture.grant = grant;
    const accounts = [
      { host: "github.com", account: "dev", active: true, authenticated: true },
      { host: "github.com", account: "bot", active: false, authenticated: true },
    ];
    const dom = await renderDom(
      <GitHubAccountSettings
        environmentId={env}
        onSaved={() => {}}
        auth={{ status: "authenticated", accounts } as never}
      />,
    );
    expect(isDisabled(dom.find('[aria-label="Use GitHub on github.com"]'))).toBe(denied);
    expect(isDisabled(dom.find('[aria-label="GitHub account for github.com"]'))).toBe(denied);
    expect(dom.text().includes(SENTENCE)).toBe(denied);
  });

  it("Cursor usage enable button", async () => {
    fixture.grant = grant;
    const dom = await renderDom(
      <CursorEnableButton environmentId={env} label="L" onEnabled={() => {}} tooltip />,
    );
    expect(dom.find('[aria-label="Enable Cursor usage from L"]') === null).toBe(denied);
    expect(dom.text().includes(SENTENCE)).toBe(denied);
  });

  it("project action dialog", async () => {
    fixture.grant = grant;
    const dom = await renderDom(projectActions(vi.fn(), false));
    await dom.click(dom.find('[aria-label="Add action"]'));
    expect(document.body.querySelector("#script-name")).not.toBeNull();
    expect(sentenceCount()).toBe(denied ? 1 : 0);
  });

  it("t3.json action import", async () => {
    fixture.grant = grant;
    const onAddScript = vi.fn(async () => ({ _tag: "Success", value: undefined }));
    const dom = await renderDom(projectActions(onAddScript, true));
    await dom.click(dom.find('[aria-label="Project actions"]'));
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes("Lint"),
    );
    expect(item).toBeDefined();
    await dom.click(item ?? null);
    expect(onAddScript.mock.calls.length > 0).toBe(!denied);
    expect(sentenceCount()).toBe(denied ? 1 : 0);
  });
});

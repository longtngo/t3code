import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";

type Grant = AsyncResult.AsyncResult<AuthSessionState, unknown>;

const fixture = vi.hoisted(() => ({ grant: null as unknown }));

// Every grant check reads the fixture through the real rules.
vi.mock("~/state/session", async (importOriginal) => {
  const { sessionResultDeniesScope, sessionResultGrantsScope } =
    await import("@t3tools/client-runtime/state/sessionScope");
  const grants = (_id: unknown, scope: never) =>
    sessionResultGrantsScope(fixture.grant as Grant, scope);
  return {
    ...(await importOriginal<typeof import("~/state/session")>()),
    readEnvironmentScope: grants,
    useEnvironmentScope: grants,
    readEnvironmentScopeDenied: (_id: unknown, scope: never) =>
      sessionResultDeniesScope(fixture.grant as Grant, scope),
    useEnvironmentScopeDenied: (_id: unknown, scope: never) =>
      sessionResultDeniesScope(fixture.grant as Grant, scope),
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

const SENTENCE = "This connection does not have permission to change environment settings.";
// Operate but not `settings:write`: a pairing from before the permission split.
const legacy: Grant = AsyncResult.success({
  authenticated: true,
  scopes: [],
  permissions: ["orchestration:read", "orchestration:operate"],
} as never);

beforeEach(() => {
  fixture.grant = legacy;
});

describe("ProjectScriptsControl under a login without settings:write", () => {
  it("opens the add dialog read-only with the reason, and sends nothing", async () => {
    const onAddScript = vi.fn();
    const dom = await renderDom(
      <ProjectScriptsControl
        environmentId={EnvironmentId.make("env-1")}
        scripts={[]}
        onAddScript={onAddScript}
        onUpdateScript={vi.fn()}
        onDeleteScript={vi.fn()}
      />,
    );
    await dom.click(dom.find('[aria-label="Add action"]'));

    expect(document.body.textContent?.split(SENTENCE)).toHaveLength(2);
    const save = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Save action",
    );
    expect(save?.disabled).toBe(true);
    expect(onAddScript).not.toHaveBeenCalled();
  });

  it("imports a t3.json action into the dialog with the reason instead of sending it", async () => {
    const onAddScript = vi.fn();
    const dom = await renderDom(
      <ProjectScriptsControl
        environmentId={EnvironmentId.make("env-1")}
        scripts={[]}
        fileScripts={[{ name: "Lint", command: "vp lint" }]}
        onAddScript={onAddScript}
        onUpdateScript={vi.fn()}
        onDeleteScript={vi.fn()}
      />,
    );
    await dom.click(dom.find('[aria-label="Project actions"]'));
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes("Lint"),
    );
    expect(item).toBeDefined();
    await dom.click(item ?? null);

    expect(onAddScript).not.toHaveBeenCalled();
    // Once: the dialog's own read-only line, not repeated as an error below it.
    expect(document.body.textContent?.split(SENTENCE)).toHaveLength(2);
    expect(document.body.querySelector<HTMLInputElement>("#script-name")?.value).toBe("Lint");
  });
});

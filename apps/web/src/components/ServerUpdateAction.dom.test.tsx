import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  continueThreadsAfterServerUpdate: false,
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    selector: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) => selector({ continueThreadsAfterServerUpdate: testState.continueThreadsAfterServerUpdate }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: Symbol("updateServer") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import { renderDom } from "../testing/renderDom";

import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "~/confirmDialog";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

// Upstream drives these flows by calling the component as a plain function and poking the
// returned element's `onClick`. That works in the `unit` project and not here: this file is
// `*.dom.test.tsx`, so it transforms through the web pipeline, where the React compiler is
// applied and the component opens with a `useMemoCache` call that needs a live dispatcher.
// Mount it for real instead - it also covers the button wiring the function call cannot see.
async function renderAction(
  overrides: Partial<ComponentProps<typeof ServerUpdateAction>> = {},
): Promise<Awaited<ReturnType<typeof renderDom>>> {
  return renderDom(
    <ServerUpdateAction
      environmentId={"env-test" as EnvironmentId}
      serverLabel="Test server"
      selfUpdate="boot-service"
      targetVersion="0.0.31"
      {...overrides}
    />,
  );
}

async function clickUpdate(view: Awaited<ReturnType<typeof renderDom>>): Promise<void> {
  await view.click(view.find("button"));
  await flushPromises();
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    testState.updateServer.mockReset();
    testState.toast.mockReset();
    testState.continueThreadsAfterServerUpdate = false;
  });

  it("reports success only after the shared update flow reconnects", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    await clickUpdate(await renderAction());

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Reconnected on t3@0.0.31.",
    });
  });

  it("reports one result when the update action is double-clicked", async () => {
    let finishUpdate: (() => void) | undefined;
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () =>
            resolve(
              AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
            );
        }),
    );

    const view = await renderAction();
    const button = view.find("button");
    await view.click(button);
    await view.click(button);

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    finishUpdate?.();
    await flushPromises();
    expect(testState.toast).toHaveBeenCalledTimes(1);
  });

  it("quietly releases the action when the operation is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    await clickUpdate(await renderAction());

    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("keeps the manual instruction for desktop servers without remote update support", async () => {
    const view = await renderDom(
      <ServerUpdateAction
        environmentId={"env-test" as EnvironmentId}
        serverLabel="Test server"
        selfUpdate="desktop-managed"
        targetVersion="0.0.31"
      />,
    );

    expect(view.text()).toContain("Update the desktop app on that machine to update this server.");
    expect(view.find("button")).toBeNull();
  });

  it("updates remote desktop apps through the shared update flow", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.34", method: "desktop-app" as const }),
    );

    // No confirm-dialog host is mounted in this test, which the component
    // treats as consent: the click itself was the request.
    await clickUpdate(
      await renderAction({ selfUpdate: "desktop-managed", desktopAppUpdate: true }),
    );

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Desktop app relaunched on 0.0.34.",
    });
  });

  it("leaves thread continuation off by default", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    await clickUpdate(await renderAction({ threadContinuation: true }));

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
  });

  it("applies the saved thread continuation preference automatically", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    testState.continueThreadsAfterServerUpdate = true;
    await clickUpdate(await renderAction({ threadContinuation: true }));

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", continueRunningThreads: true },
    });
  });
});

describe("ServerUpdatesAction", () => {
  let renderer: ReactTestRenderer | undefined;
  const targets: ReadonlyArray<ServerUpdateTarget> = [
    {
      environmentId: "batch-a" as EnvironmentId,
      serverLabel: "Laptop",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: true,
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: false,
    },
    {
      environmentId: "batch-c" as EnvironmentId,
      serverLabel: "Manual",
      selfUpdate: null,
      targetVersion: "0.0.31",
    },
  ];
  const success = AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const });

  async function mount(batch = targets) {
    await act(async () => {
      renderer = create(<ServerUpdatesAction targets={batch} />);
    });
    return renderer!.root.findByType("button");
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.updateServer.mockReset();
    testState.toast.mockReset();
    resetConfirmDialogForTests();
  });
  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    resetConfirmDialogForTests();
    vi.unstubAllGlobals();
  });

  it("updates both supported machines with their own continuation preference and skips the manual machine", async () => {
    testState.updateServer.mockResolvedValue(success);
    const button = await mount();
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.updateServer.mock.calls.map(([target]) => target)).toEqual([
      {
        environmentId: "batch-a",
        input: { targetVersion: "0.0.31", continueRunningThreads: true },
      },
      { environmentId: "batch-b", input: { targetVersion: "0.0.31" } },
    ]);
    expect(testState.toast.mock.calls.map(([toast]) => toast.title)).toEqual([
      "Laptop updated",
      "Office updated",
    ]);
  });

  it("names a failed machine while letting the other machine complete", async () => {
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success);
    const button = await mount();
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button.props.disabled).toBe(false);
  });

  it("starts each machine once when double-clicked and disables the action until both finish", async () => {
    const completions: Array<() => void> = [];
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve(success));
        }),
    );
    const button = await mount();
    await act(async () => {
      button.props.onClick();
      button.props.onClick();
    });
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      completions[0]!();
    });
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      completions[1]!();
    });
    expect(button.props.disabled).toBe(false);
    expect(testState.toast).toHaveBeenCalledTimes(2);
  });

  it("asks once for desktop machines and cancels the entire batch", async () => {
    registerConfirmDialogHost();
    const button = await mount(
      targets.map((target, index) =>
        index < 2 ? { ...target, selfUpdate: "desktop-managed", desktopAppUpdate: true } : target,
      ),
    );
    await act(async () => {
      button.props.onClick();
    });
    const confirmation = readConfirmDialogState();
    expect(confirmation).toEqual(
      expect.objectContaining({
        status: "confirming",
        message: expect.stringContaining("Laptop, Office"),
      }),
    );
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => {
      respondToConfirmDialog(false);
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(button.props.disabled).toBe(false);
  });
});

describe("ServerUpdateProgress", () => {
  it("shows one calm status row for the restart wait", async () => {
    const view = await renderDom(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(view.text()).toContain("Restarting…");
    // The wait state is monochrome and calm: no versions, no step rail, no
    // success/warning colors, one duty-cycled pulse on the dot.
    expect(view.text()).not.toContain("0.0.30");
    expect(view.text()).not.toContain("Resum");
    expect(view.findAll('[class*="text-success"]')).toHaveLength(0);
    expect(view.findAll('[class*="text-primary"]')).toHaveLength(0);
    expect(view.find(".animate-status-pulse")).not.toBeNull();
    expect(view.findAll('[class*="animate-spin"]')).toHaveLength(0);
  });

  it("folds the sub-second installing handoff into the download phase", async () => {
    const view = await renderDom(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(view.text()).toContain("Downloading…");
    expect(view.text()).not.toContain("Install");
  });

  it("keeps the failure visible with its retryable error", async () => {
    const view = await renderDom(
      <ServerUpdateProgress
        state={{
          status: "failed",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
          message: "The package could not be verified.",
        }}
      />,
    );

    expect(view.find('[role="alert"]')).not.toBeNull();
    expect(view.text()).toContain("The package could not be verified.");
    expect(view.find(".animate-status-pulse")).toBeNull();
  });
});

import { RegistryContext } from "@effect/atom-react";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Seams: the rename dialog, the primary environment, its server config atom, the session scope and
// the outgoing settings command. The dialog resolves on demand so the config can change while it
// is open, as a peer's delete would.
const fixture = vi.hoisted(() => ({
  submit: (_name: string | null) => {},
  writes: [] as Array<Record<string, unknown>>,
  // What the server reply stores; null echoes the patch (the write landed).
  stored: null as Record<string, unknown> | null,
  toasts: [] as Array<{ title?: string }>,
  confirmed: true,
  prompts: [] as string[],
  threads: [] as Array<{ archivedAt: string | null; sidebarSectionId: string | null }>,
}));

vi.mock("./components/SidebarSectionNameDialog", () => ({
  requestSidebarSectionName: () =>
    new Promise<string | null>((resolve) => {
      fixture.submit = resolve;
    }),
}));
vi.mock("./state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "primary" }),
}));
vi.mock("./state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    primaryServerConfigAtom: Atom.keepAlive(Atom.make<unknown>(null)),
    serverEnvironment: { updateSettings: {} },
  };
});
vi.mock("./localApi", () => ({
  readLocalApi: () => ({
    dialogs: {
      confirm: async (message: string) => {
        fixture.prompts.push(message);
        return fixture.confirmed;
      },
    },
  }),
}));
vi.mock("./state/entities", () => ({ readThreadShells: () => fixture.threads }));
vi.mock("./components/ui/toast", () => ({
  toastManager: { add: (toast: { title?: string }) => fixture.toasts.push(toast) },
}));
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand:
    () => async (value: { input: { patch: { sidebarSections: Record<string, unknown> } } }) => {
      const { AsyncResult } = await import("effect/reactivity");
      fixture.writes.push(value.input.patch.sidebarSections);
      return AsyncResult.success({
        sidebarSections: fixture.stored ?? value.input.patch.sidebarSections,
      });
    },
}));

import { useSidebarSectionCommands } from "./sidebarCustomSections";
import type { SidebarSectionView } from "./sidebarCustomSections.logic";
import { primaryServerConfigAtom } from "./state/server";
import { renderDom } from "./testing/renderDom";

const configAtom = primaryServerConfigAtom as unknown as Atom.Writable<unknown>;
const createdAt = "2026-10-07T00:00:00.000Z";
const config = (sections: Record<string, { name: string; createdAt: string }>) => ({
  environment: { capabilities: { sidebarSections: true } },
  settings: { sidebarSections: sections },
});
const opened: SidebarSectionView = { id: "s1", name: "Focus", createdAt };

let registry: AtomRegistry.AtomRegistry;
let commands: ReturnType<typeof useSidebarSectionCommands> | null = null;

function Harness() {
  const live = useSidebarSectionCommands();
  useEffect(() => {
    commands = live;
  });
  return null;
}

beforeEach(() => {
  registry = AtomRegistry.make();
  registry.set(configAtom, config({ s1: { name: "Focus", createdAt } }));
  fixture.writes = [];
  fixture.stored = null;
  fixture.toasts = [];
  fixture.confirmed = true;
  fixture.prompts = [];
  fixture.threads = [];
});

async function mount() {
  await renderDom(
    <RegistryContext.Provider value={registry}>
      <Harness />
    </RegistryContext.Provider>,
  );
}

/** Opens the name dialog with `open`, runs `change` while it is open, then submits. */
async function submitWhile(open: () => Promise<void>, change: () => void, submitted: string) {
  await mount();
  let done: Promise<void> = Promise.resolve();
  await act(async () => {
    done = open();
  });
  change();
  await act(async () => {
    fixture.submit(submitted);
    await done;
  });
}

const renameWhile = (change: () => void, submitted: string) =>
  submitWhile(() => commands!.rename(opened), change, submitted);

async function remove() {
  await mount();
  await act(async () => {
    await commands!.remove(opened);
  });
}

describe("rename re-reads the live sections when the dialog closes", () => {
  it("writes the new name when the section is still there", async () => {
    await renameWhile(() => {}, "Deep work");
    expect(fixture.writes).toEqual([{ s1: { name: "Deep work", createdAt } }]);
  });

  it("a section deleted while the dialog was open stays deleted", async () => {
    await renameWhile(() => registry.set(configAtom, config({})), "Deep work");
    expect(fixture.writes).toEqual([]);
    expect(fixture.toasts.map((toast) => toast.title)).toEqual(["Section was deleted"]);
  });

  it("an unchanged submit keeps a peer's rename", async () => {
    await renameWhile(
      () => registry.set(configAtom, config({ s1: { name: "Peer", createdAt } })),
      "Focus",
    );
    expect(fixture.writes).toEqual([]);
    expect(fixture.toasts).toEqual([]);
  });
});

describe("a write the server did not apply names what failed", () => {
  it("says a delete did not happen", async () => {
    fixture.stored = { s1: { name: "Focus", createdAt } };
    await remove();
    expect(fixture.toasts.map((toast) => toast.title)).toEqual(["Section not deleted"]);
  });

  it("says a rename did not happen", async () => {
    fixture.stored = { s1: { name: "Focus", createdAt } };
    await renameWhile(() => {}, "Deep work");
    expect(fixture.toasts.map((toast) => toast.title)).toEqual(["Section not renamed"]);
  });

  it("says a create did not happen", async () => {
    fixture.stored = {};
    await submitWhile(
      () => commands!.create(),
      () => {},
      "New",
    );
    expect(fixture.toasts.map((toast) => toast.title)).toEqual(["Section not created"]);
  });
});

describe("delete confirms with the member count first", () => {
  beforeEach(() => {
    fixture.threads = [
      { archivedAt: null, sidebarSectionId: "s1" },
      { archivedAt: null, sidebarSectionId: "s1" },
      { archivedAt: createdAt, sidebarSectionId: "s1" },
      { archivedAt: null, sidebarSectionId: "other" },
    ];
  });

  it("deletes after the user confirms, counting only unarchived members", async () => {
    await remove();
    expect(fixture.prompts).toEqual(['Delete section "Focus"?\nIts 2 threads return to Active.']);
    expect(fixture.writes).toEqual([{ s1: null }]);
  });

  it("writes nothing when the user cancels", async () => {
    fixture.confirmed = false;
    await remove();
    expect(fixture.writes).toEqual([]);
  });

  it("a section a peer already deleted gets no confirm, only a toast", async () => {
    registry.set(configAtom, config({}));
    await remove();
    expect(fixture.prompts).toEqual([]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.toasts.map((toast) => toast.title)).toEqual(["Section was deleted"]);
  });
});

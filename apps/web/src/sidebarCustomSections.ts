/**
 * Sidebar section definitions live on the primary environment's server, so every client of that
 * machine shares them. Membership is per thread (`thread.section.set`).
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type SidebarSectionDefinition } from "@t3tools/contracts";
import { useCallback, useContext, useMemo } from "react";

import { requestSidebarSectionName } from "./components/SidebarSectionNameDialog";
import { toastManager } from "./components/ui/toast";
import { readLocalApi } from "./localApi";
import { readThreadShells } from "./state/entities";
import { usePrimaryEnvironment } from "./state/environments";
import { primaryServerConfigAtom, serverEnvironment } from "./state/server";
import { useEnvironmentScope } from "./state/session";
import { useAtomCommand } from "./state/use-atom-command";
import {
  newSidebarSectionId,
  planSidebarSectionRename,
  resolveSidebarSections,
  sidebarSectionDeleteMessage,
  sidebarSectionGone,
  sidebarSectionPatchLanded,
  type SidebarSectionView,
} from "./sidebarCustomSections.logic";

const NOT_APPLIED = {
  create: { title: "Section not created", description: "The server did not store the section." },
  rename: { title: "Section not renamed", description: "The server kept the old name." },
  delete: { title: "Section not deleted", description: "The server kept the section." },
} as const;

/** Null means no section UI: no primary, or a primary that does not store sections. */
export function useSidebarSections(): readonly SidebarSectionView[] | null {
  const config = useAtomValue(primaryServerConfigAtom);
  return useMemo(() => resolveSidebarSections(config), [config]);
}

/**
 * `canEdit` gates create, rename and delete: the server requires settings:write for a
 * `sidebarSections` patch, so a read-only client hides those controls.
 */
export function useSidebarSectionCommands() {
  const primaryId = usePrimaryEnvironment()?.environmentId ?? null;
  // `updateSettings.permissionAtom` would always read true: the client does not guard that RPC
  // (its scope depends on the patch), so read the session scope the server checks instead.
  const canEdit = useEnvironmentScope(primaryId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const registry = useContext(RegistryContext);
  const write = useCallback(
    async (
      patch: Record<string, SidebarSectionDefinition | null>,
      change: keyof typeof NOT_APPLIED,
    ): Promise<boolean> => {
      if (primaryId === null) return false;
      const result = await updateSettings({
        environmentId: primaryId,
        input: { patch: { sidebarSections: patch } },
      });
      // A transport failure is already reported by useAtomCommand.
      if (result._tag !== "Success") return false;
      if (sidebarSectionPatchLanded(result.value.sidebarSections, patch)) return true;
      toastManager.add({ type: "warning", ...NOT_APPLIED[change] });
      return false;
    },
    [primaryId, updateSettings],
  );
  const create = useCallback(async () => {
    const name = await requestSidebarSectionName({ title: "New section", initialName: "" });
    if (name === null) return;
    await write(
      { [newSidebarSectionId()]: { name, createdAt: new Date().toISOString() } },
      "create",
    );
  }, [write]);
  const rename = useCallback(
    async (section: SidebarSectionView) => {
      const name = await requestSidebarSectionName({
        title: "Rename section",
        initialName: section.name,
      });
      if (name === null) return;
      const live = resolveSidebarSections(registry.get(primaryServerConfigAtom));
      if (sidebarSectionGone(live, section.id)) {
        toastManager.add({
          type: "info",
          title: "Section was deleted",
          description: "The new name was not saved.",
        });
        return;
      }
      const patch = planSidebarSectionRename(live, section.id, section.name, name);
      if (patch !== null) await write(patch, "rename");
    },
    [registry, write],
  );
  const remove = useCallback(
    async (section: SidebarSectionView) => {
      // A stale menu (header, right-click, palette submenu) can still offer a section a peer deleted.
      if (
        sidebarSectionGone(
          resolveSidebarSections(registry.get(primaryServerConfigAtom)),
          section.id,
        )
      ) {
        toastManager.add({
          type: "info",
          title: "Section was deleted",
          description: "It was already removed.",
        });
        return;
      }
      // Every member returns to Active, wherever it rests now (queued, pinned, settled, ...).
      const count = readThreadShells().filter(
        (thread) => thread.archivedAt === null && thread.sidebarSectionId === section.id,
      ).length;
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(sidebarSectionDeleteMessage(section.name, count), {
          variant: "destructive",
        }),
      );
      if (confirmed._tag === "Success" && confirmed.value) {
        await write({ [section.id]: null }, "delete");
      }
    },
    [registry, write],
  );
  return useMemo(() => ({ canEdit, create, rename, remove }), [canEdit, create, remove, rename]);
}

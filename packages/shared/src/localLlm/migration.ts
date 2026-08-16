import type {
  LocalLlmModelConfig,
  LocalLlmSettings,
  LocalModelsSettings,
} from "@t3tools/contracts";
import { LOCAL_LLM_MODELS } from "./catalog.ts";

/**
 * Re-group a flat `["--flag", "val"]` token array into grouped `["--flag val"]`
 * tokens, the form the new schema/UI use. A bare flag (`--no-pld`) or a flag
 * followed by another flag stays on its own.
 */
function groupArgs(flat: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flat.length; i++) {
    const tok = flat[i];
    if (tok === undefined) continue;
    const next = flat[i + 1];
    if (tok.startsWith("-") && next !== undefined && !next.startsWith("-")) {
      out.push(`${tok} ${next}`);
      i++;
    } else {
      out.push(tok);
    }
  }
  return out;
}

/**
 * Migrate the deprecated `localModels` settings into the new `localLlm` shape.
 *
 * - provider-level fields (modelsDir / defaultArgs / ds4.*) become catalog
 *   provider overrides; `ds4.enabled` becomes `ds4` provider visibility.
 * - each `perModel` key that matches a catalog model `resourceName` seeds a
 *   model config carrying its arg overrides; non-catalog keys are dropped.
 */
export function migrateLocalModels(legacy: LocalModelsSettings): LocalLlmSettings {
  const byResource = new Map(LOCAL_LLM_MODELS.map((m) => [m.resourceName, m]));
  const models: LocalLlmModelConfig[] = [];
  let n = 0;

  const seedFrom = (
    perModel:
      | Readonly<Record<string, { readonly args?: readonly string[] | undefined }>>
      | undefined,
  ) => {
    for (const [key, v] of Object.entries(perModel ?? {})) {
      const m = byResource.get(key);
      if (!m) continue; // non-catalog keys dropped
      if (models.some((c) => c.modelId === m.id)) continue; // de-dupe across both maps
      models.push({
        id: `mig-${++n}`,
        name: m.name,
        providerId: m.ds4Only ? "ds4" : "mlx-serve",
        modelId: m.id,
        contextWindow: m.maxContext,
        visible: true,
        argsOverride: v.args ? groupArgs(v.args) : undefined,
      });
    }
  };

  seedFrom(legacy.perModel);
  seedFrom(legacy.ds4?.perModel);

  return {
    ramBudgetBytes: legacy.ramBudgetBytes ?? 0,
    providers: {
      "mlx-serve": {
        visible: true,
        modelsDir: legacy.modelsDir,
        defaultArgs: legacy.defaultArgs ? groupArgs(legacy.defaultArgs) : undefined,
      },
      ds4: {
        visible: legacy.ds4?.enabled ?? false,
        binaryPath: legacy.ds4?.binaryPath,
        modelsDir: legacy.ds4?.modelsDir,
        defaultArgs: legacy.ds4?.defaultArgs ? groupArgs(legacy.ds4.defaultArgs) : undefined,
      },
    } as LocalLlmSettings["providers"],
    models,
  };
}

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
 * - provider-level fields (modelsDir / defaultArgs) become catalog provider overrides.
 * - each `perModel` key that matches a catalog model `resourceName` seeds a
 *   model config carrying its arg overrides; non-catalog keys are dropped.
 *
 * The legacy shape also carried a `ds4` block. That engine is retired and gone from the
 * catalog, so its models no longer match anything and its provider override would name a
 * provider that does not exist — the block is read and dropped rather than migrated.
 */
export function migrateLocalModels(legacy: LocalModelsSettings): LocalLlmSettings {
  const byResource = new Map(LOCAL_LLM_MODELS.map((m) => [m.resourceName, m]));
  const models: LocalLlmModelConfig[] = [];
  let n = 0;

  for (const [key, v] of Object.entries(legacy.perModel ?? {})) {
    const m = byResource.get(key);
    if (!m) continue; // non-catalog keys dropped
    models.push({
      id: `mig-${++n}`,
      name: m.name,
      providerId: "mlx-serve",
      modelId: m.id,
      contextWindow: m.maxContext,
      visible: true,
      argsOverride: v.args ? groupArgs(v.args) : undefined,
    });
  }

  return {
    ramBudgetBytes: legacy.ramBudgetBytes ?? 0,
    providers: {
      "mlx-serve": {
        visible: true,
        modelsDir: legacy.modelsDir,
        defaultArgs: legacy.defaultArgs ? groupArgs(legacy.defaultArgs) : undefined,
      },
    } as LocalLlmSettings["providers"],
    models,
  };
}

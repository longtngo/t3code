import type { ArgSpec } from "@t3tools/shared/localLlm";

/** A flag-only spec becomes "--x"; a valued spec becomes "--x value" (grouped token). */
export function buildArg(spec: ArgSpec, value?: string): string {
  if (spec.type === "flag") return spec.flag;
  return `${spec.flag} ${value ?? ""}`.trim();
}

/** Filter specs by a query matched against the flag and its description. */
export function filterSpecs(specs: readonly ArgSpec[], query: string): ArgSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...specs];
  return specs.filter((s) => `${s.flag} ${s.desc ?? ""}`.toLowerCase().includes(q));
}

export function addArg(list: readonly string[], str: string): string[] {
  return [...list, str];
}

export function removeArg(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}

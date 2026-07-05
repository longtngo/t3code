#!/usr/bin/env node
/**
 * Prints the low-bandwidth wire-size budget (Phase 0 baseline).
 *
 *   node scripts/wire-budget.ts
 *
 * Re-run after each roadmap phase and compare against the recorded baseline in
 * docs/superpowers/specs/2026-07-05-low-bandwidth-support-design.md.
 */

import { computeBudgetReport } from "./lib/wireBudget.ts";

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function savedPercent(before: number, after: number): number {
  return before > 0 ? Math.round((1 - after / before) * 100) : 0;
}

function main(): void {
  const { frames, scenarios } = computeBudgetReport();
  const lines: string[] = [];
  const header = `${pad("", 42)}${padLeft("JSON", 12)}${padLeft("JSON+deflate", 16)}`;

  lines.push("", "Per-frame wire size (current JSON transport)", "", header, "-".repeat(70));
  for (const { name, sizes } of frames) {
    const deflated = `${fmtBytes(sizes.jsonDeflated)} (-${savedPercent(sizes.json, sizes.jsonDeflated)}%)`;
    lines.push(`${pad(name, 42)}${padLeft(fmtBytes(sizes.json), 12)}${padLeft(deflated, 16)}`);
  }

  lines.push("", "Scenario byte budgets", "", header, "-".repeat(70));
  for (const { name, json, jsonDeflated, detail } of scenarios) {
    const deflated = `${fmtBytes(jsonDeflated)} (-${savedPercent(json, jsonDeflated)}%)`;
    lines.push(`${pad(name, 42)}${padLeft(fmtBytes(json), 12)}${padLeft(deflated, 16)}`);
    lines.push(`  (${detail})`);
  }
  lines.push("");

  process.stdout.write(`${lines.join("\n")}\n`);
}

main();

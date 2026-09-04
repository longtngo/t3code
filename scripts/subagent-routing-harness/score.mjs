/**
 * Scores a directory of `claude --output-format stream-json` runs into a wrapper share.
 *
 * M = wrapper dispatches / all subagent dispatches. Anything below the threshold means the
 * instruction stopped steering the model, which no test in `pnpm verify` can tell you.
 *
 * Usage: node score.mjs <runs-dir> [threshold]
 */
import * as NodeFS from "node:fs";

/**
 * A dispatch is an INVOCATION of the wrapper, not a mention of its path. Split the command into
 * segments and require the wrapper to lead one — `ls ~/bin/subagent-dispatch` and
 * `cat .../subagent-dispatch` are the model inspecting the harness, and counting those as
 * dispatches inflated an early run of this experiment.
 */
const isDispatch = (command) =>
  String(command)
    .split(/(?:&&|\|\||;|\n)/)
    .some((segment) =>
      /^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:\S*\/)?subagent-dispatch\s+\S+\s+\S+/.test(segment),
    );

const runsDir = process.argv[2];
const threshold = Number(process.argv[3] ?? "0.9");
if (runsDir === undefined) {
  console.error("usage: node score.mjs <runs-dir> [threshold]");
  process.exit(64);
}

const rows = [];
for (const file of NodeFS.readdirSync(runsDir)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()) {
  let wrapper = 0;
  let native = 0;
  let completed = false;
  for (const line of NodeFS.readFileSync(`${runsDir}/${file}`, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "result") completed = event.subtype === "success";
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "Agent" || block.name === "Task") native++;
      else if (block.name === "Bash" && isDispatch(block.input?.command ?? "")) wrapper++;
    }
  }
  rows.push({ run: file.replace(".jsonl", ""), wrapper, native, completed });
}

const wrapper = rows.reduce((n, r) => n + r.wrapper, 0);
const native = rows.reduce((n, r) => n + r.native, 0);
const dispatches = wrapper + native;
const completed = rows.filter((r) => r.completed).length;

console.table(rows);
if (dispatches === 0) {
  console.error(
    "\nNo subagent dispatches at all. The harness did not exercise routing — check the run logs " +
      "for a Bash failure before drawing any conclusion from this.",
  );
  process.exit(1);
}
const m = wrapper / dispatches;
console.log(
  `\nn=${rows.length}  dispatches=${dispatches}  wrapper=${wrapper}  native=${native}` +
    `  M=${m.toFixed(3)}  completed=${completed}/${rows.length}`,
);
let failed = false;
if (m < threshold) {
  console.error(`FAIL: M ${m.toFixed(3)} < ${threshold}`);
  failed = true;
}
// Every run must finish the task, in both modes. In --fallback this IS the assertion: offload is
// unavailable, so the point is that the agent degrades to a Claude subagent and still delivers,
// which is the guardrail that chose injection over gating the Agent tool away.
if (completed < rows.length) {
  console.error(`FAIL: only ${completed}/${rows.length} runs completed the task`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`PASS: M ${m.toFixed(3)} >= ${threshold}, ${completed}/${rows.length} completed`);

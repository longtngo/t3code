#!/bin/bash
# Measures whether the shipped dispatch instruction still routes subagents through
# ~/bin/subagent-dispatch instead of Claude Code's native Agent tool.
#
# Run this whenever the instruction text changes. `pnpm verify` cannot tell you: the behaviour
# under test is a model's tool choice, not a code path. See
# docs/design/2026-09-04-subagent-dispatch-instruction-design.md.
#
# This spends real Claude tokens - one short session per trial. Cursor is stubbed, so it costs
# nothing on that side.
#
#   ./run.sh              8 trials, offload ON, expect M >= 0.90
#   ./run.sh -n 4         4 trials
#   ./run.sh --fallback   offload UNAVAILABLE: the wrapper refuses, and the model must fall back
#                         to the Agent tool and still finish. Guards the exit-3 clause.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TRIALS=8
FALLBACK=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) TRIALS=$2; shift 2 ;;
    --fallback) FALLBACK=1; shift ;;
    *) echo "usage: $0 [-n TRIALS] [--fallback]" >&2; exit 64 ;;
  esac
done

command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 69; }

# The instruction comes from the source, never a copy here. A copy is exactly what drifted last
# time: the text was edited twice after it was measured.
INSTRUCTION=$(cd "$HERE" && node --experimental-strip-types print-instruction.mjs) || {
  echo "could not read the shipped instruction from ClaudeAdapter.ts" >&2; exit 70; }
[ -n "$INSTRUCTION" ] || { echo "shipped instruction is empty" >&2; exit 70; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/subagent-routing-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo" "$WORK/runs"
cp "$HERE/fixtures/alpha.py" "$HERE/fixtures/beta.py" "$WORK/repo/"

# Stub standing in for cursor-agent. It answers plausibly on purpose: an obviously fake reply
# sends the model off investigating the harness instead of doing the task.
cat > "$WORK/agent-stub" <<'STUB'
#!/bin/bash
prompt="${!#}"
case "$prompt" in
  *alpha*|*total*) echo "alpha.py defines total(rows), which sums the amount field of every row whose status is settled." ;;
  *beta*|*bucket*) echo "beta.py defines bucket(rows, size), which splits rows into consecutive chunks of size and drops any short tail." ;;
  *) echo "Reviewed the file and summarised its single function." ;;
esac
STUB
chmod +x "$WORK/agent-stub"

if [ "$FALLBACK" -eq 1 ]; then
  printf '{"schemaVersion":1,"backend":"default","instanceId":null,"model":null,"binaryPath":null,"apiEndpoint":"","updatedAt":null,"degraded":null}\n' > "$WORK/state.json"
else
  printf '{"schemaVersion":1,"backend":"cursor","instanceId":"cursor","model":"auto","binaryPath":"%s","apiEndpoint":"","updatedAt":null,"degraded":null}\n' "$WORK/agent-stub" > "$WORK/state.json"
fi

PROMPT='Using two subagents working in parallel, one per file, summarise in one sentence each what alpha.py and beta.py in this directory do. Report both summaries.'

# `--setting-sources project,local`, deliberately NOT `user` -- even though production passes
# `user` too (CLAUDE_SETTING_SOURCES). A personal ~/.claude/CLAUDE.md that already tells the agent
# to use the wrapper steers it on its own: measured here, a deliberately neutered instruction that
# never names `subagent-dispatch` still scored M=1.000 with `user` enabled. That makes the harness
# unable to fail, which makes it worthless. Dropping `user` leaves the shipped instruction as the
# only signal, which is both the question being asked and the situation of any user who does not
# happen to have that rule in their dotfiles.
#
# Serial on purpose. These share one rate-limited backend; running them in parallel measures the
# rate limiter, not the instruction.
for n in $(seq 1 "$TRIALS"); do
  echo "[$(date +%H:%M:%S)] trial $n/$TRIALS"
  (cd "$WORK/repo" && SUBAGENT_BACKEND_STATE="$WORK/state.json" claude \
    -p "$PROMPT" --output-format stream-json --verbose --model claude-opus-5 \
    --permission-mode bypassPermissions --dangerously-skip-permissions \
    --setting-sources project,local --append-system-prompt "$INSTRUCTION" \
    > "$WORK/runs/trial-$n.jsonl" 2> "$WORK/runs/trial-$n.err")
done

if [ "$FALLBACK" -eq 1 ]; then
  # Offload is unavailable, so wrapper attempts SHOULD be refused and the model SHOULD land on
  # the Agent tool. A high M here would mean the refusal is not being honoured.
  node "$HERE/score.mjs" "$WORK/runs" 0
else
  node "$HERE/score.mjs" "$WORK/runs" 0.9
fi

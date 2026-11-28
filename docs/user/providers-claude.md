# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Multiple accounts and presets

Isolate separate Claude accounts or router presets with distinct `CLAUDE_CONFIG_DIR` directories:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add a second Claude instance in **Settings → Providers** (or **Add Claude account** on mobile) pointing **CLAUDE_CONFIG_DIR path** to `~/.claude_personal` (leave empty for the default directory). Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

- Existing threads switch only between Claude instances that share one conversation store; see [switching a thread between Claude accounts](#switching-a-thread-between-claude-accounts).
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

### Switching a thread between Claude accounts

An existing thread can switch between two Claude instances whose config directories
share one `projects` directory - for example, `~/.claude_personal/projects` set up as
a symlink to `~/.claude/projects`. That directory is where Claude Code keeps the
conversation transcripts it resumes from, so two instances sharing it count as the
same Claude environment and the thread keeps its history. Two things follow from
sharing it: both accounts can read and resume each other's conversations, and after
a switch the thread continues under the other account, with that account's tool
permissions and trust settings. Stop a running turn before switching.

Otherwise the switch is refused: a separate config directory has its own transcripts,
and the thread would lose its history.

This differs from the recommended Codex setup. Codex shares its home directly, so any
two Codex instances pointed at the same home are already one group. Claude shares
through the `projects` link instead, because Claude Code keeps account and local state
in several other files under its config directory that do not need sharing.

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** in the Claude instance settings to a token count (`100000`–`1000000`) or a percentage of the model's context window such as `60%`; see [auto-compact threshold](#auto-compact-threshold).
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

### Auto-compact threshold

A token count such as `300000` compacts the conversation into a summary once it reaches about
300,000 tokens, without changing the model's context window. A percentage follows the model you
are using, so one setting keeps its meaning when you switch between a 200,000-token model and a
1,000,000-token one. A token count does not: it is capped at the model's own window, so `600000`
quietly means 200,000 on a 200,000-token model. The percent sign is required, because a bare
number is always a token count.

Leave the field empty to keep Claude Code's default behavior. For some models Claude Code does not
compact on its own at all, so T3 Code fills in that model's own window and compaction starts about
33,000 tokens below it - around 967,000 on a 1,000,000-token model, or 167,000 on a 200,000-token
one. Models Claude Code already compacts are left alone, so its own tuning keeps working. Anything
you type in the field always takes priority.

Because T3 Code passes this setting to Claude Code at the highest priority, the `/autocompact`
command inside a conversation cannot override it, and neither can an `autoCompactWindow` value in
your own Claude Code configuration file. Change it here instead. To switch automatic compaction
off altogether, set `autoCompactEnabled` to `false` in your Claude Code settings file, which T3
Code never overrides.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

## Skills and MCP sign-in

- **Skills**: Loaded from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills` (config dir wins on name collisions), and enabled Claude plugins (e.g. `plugin:review`). Invoke via `$`. Send `disable-model-invocation` skills one per message.
- **MCP OAuth**: When a Claude MCP server needs sign-in, click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into T3 Code (**Finish sign-in**). Connectors added on `claude.ai` authenticate there instead.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.

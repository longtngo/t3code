# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in.

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

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Compact long conversations

In Settings, open your Claude provider and set **Auto-compact after** to either a token count
between `100000` and `1000000`, or a percentage of the model's context window such as `60%`. For
example, `300000` compacts the conversation into a summary once it reaches about 300,000 tokens,
without changing the model's context window.

A percentage follows the model you are using, so one setting keeps its meaning when you switch
between a 200,000-token model and a 1,000,000-token one. A token count does not: it is capped at
the model's own window, so `600000` quietly means 200,000 on a 200,000-token model. The percent
sign is required, because a bare number is always a token count.

Leave the field empty to keep Claude Code's default behavior. For some models Claude Code does not
compact on its own at all, so T3 Code fills in that model's own window and compaction starts about
33,000 tokens below it — around 967,000 on a 1,000,000-token model, or 167,000 on a 200,000-token
one. Models Claude Code already compacts are left alone, so its own tuning keeps working. Anything
you type in the field always takes priority.

The context meter shows where this lands. Open it and you will see the model's full window as the
denominator, with a marker on the bar at the point compaction will actually fire and the token
figure beneath it. When the meter shows no marker, Claude Code is not compacting this conversation
automatically, whatever the field says.

Because T3 Code passes this setting to Claude Code at the highest priority, the `/autocompact`
command inside a conversation cannot override it, and neither can an `autoCompactWindow` value in
your own Claude Code configuration file. Change it here instead. To switch automatic compaction
off altogether, set `autoCompactEnabled` to `false` in your Claude Code settings file, which T3
Code never overrides.

On web and desktop, when you return to an older Claude thread with a large context, T3 Code
offers to compact the conversation before you continue. You can also select **Compact context**
from the context meter. On every client, you can enter `/compact` in the message composer, and

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.

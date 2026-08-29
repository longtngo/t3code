# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

You can attach images up to 10 MB. On servers that support file uploads, web and desktop can also
attach text files, PDFs, ZIP archives, and other files. Each file can be up to the limit advertised
by the server, capped at 50 MB. Each message can contain up to eight attachments in total. Files
upload directly to the environment, where your agent can read, copy, or edit them by their file path.

On web and desktop, attachments upload as soon as you add them. The send button becomes available
after every upload finishes. Failed uploads can be retried or removed. On mobile, attachments are
currently limited to images.

If you reload before a file finishes uploading, the draft keeps the file's name and shows **Attach
again** next to it. Attach the file again or remove it, then send.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Prompt stash

Use the default shortcut, `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux, to stash the current
prompt and its attachments after all file uploads finish. Restore the entry later from the stash
menu. Stashes that contain files must be restored in the environment where those files were
uploaded. Stashed files stay uploaded on the server for 24 hours. If you restore an entry after
that, the file comes back with **Attach again** next to it. Attach the file again or remove it, then
send.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On mobile, these menus are available on the **New task** screen before you start a thread. They
use the skills and commands from the selected environment and provider.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Sending while the agent is working

You do not have to wait for the agent to finish before sending. A message sent
mid-turn is held and delivered when the current turn ends; it is never mixed
into the answer already in progress.

A held message does not appear in the conversation. It waits in a strip just
above the message box, showing a count of what is queued; opening the strip
lists each message in the order it will be sent. It joins the conversation when
it is actually delivered, so what you see in the thread is what the agent has
seen.

### Taking a message back

In the strip, a held message can be pulled back into the message box for
editing. Its text is added to whatever you have already typed rather than
replacing it. Attachments are not brought back and need attaching again.

If the agent has already been handed the message, taking it back is no longer
possible and T3 Code says so. The message is a normal message from then on.

Recall is available with Claude. Other providers pass a held message straight
through to the agent rather than holding it in a queue T3 Code can reach into,
so their held messages are listed but cannot be taken back.

Stopping the agent discards anything still waiting, so use Stop when you want to
change direction rather than add to what was asked. A discarded message stays
visible in the conversation as something you typed; it is simply never
answered.

### Escape

`Escape` walks the same ladder the Stop button does, without reaching for the
mouse. While a message is still waiting, `Escape` takes the most recent one
back into the message box. Once nothing is waiting, `Escape` stops the agent,
and a second deliberate press force-stops the session.

The second press has to be a deliberate one. A press that lands immediately
after the first is treated as a slip and ignored, and holding `Escape` down does
not walk the ladder at all, so the force-stop is never something you arrive at
by accident.

While the agent is waiting on a question or an approval, `Escape` does nothing.
The message box offers **Cancel** there, which declines without stopping the
session, and that is a different decision from stopping the agent.

`Escape` keeps its usual meaning everywhere else. It only stops the agent when
the message box has focus or nothing does; while a dialog, a menu, or a terminal
is open, `Escape` closes that instead.

## Hiding the workspace row

Below the composer, a row shows which workspace and branch the agent will work in. The folder
button in the composer's bottom row hides and restores it, which is worth doing on a phone where
that row costs space you would rather give to the conversation.

The row stays visible until you hide it, and the choice is remembered on that device only, so a
phone can keep it hidden while a desktop keeps it open. While the row is hidden, the folder button
still shows whether the thread is running in a worktree or in the local checkout.

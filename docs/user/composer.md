# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

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

## Hiding the workspace row

Below the composer, a row shows which workspace and branch the agent will work in. The folder
button in the composer's bottom row hides and restores it, which is worth doing on a phone where
that row costs space you would rather give to the conversation.

The row stays visible until you hide it, and the choice is remembered on that device only, so a
phone can keep it hidden while a desktop keeps it open. While the row is hidden, the folder button
still shows whether the thread is running in a worktree or in the local checkout.

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

A held message shows a "Waiting for the current turn to finish" note beneath it,
so it is clear the agent has not seen it yet. If you send several, each one is
marked. The note clears on its own when the turn ends and the message is
delivered.

Stopping the agent discards anything still waiting, so use Stop when you want to
change direction rather than add to what was asked.

The note appears for Claude and Codex, which start a distinct turn for the held
message. Other providers hold the message the same way, but continue under the
turn that was already running, so there is no separate turn for the note to
track.

## Hiding the workspace row

Below the composer, a row shows which workspace and branch the agent will work in. The folder
button in the composer's bottom row hides and restores it, which is worth doing on a phone where
that row costs space you would rather give to the conversation.

The row stays visible until you hide it, and the choice is remembered on that device only, so a
phone can keep it hidden while a desktop keeps it open. While the row is hidden, the folder button
still shows whether the thread is running in a worktree or in the local checkout.

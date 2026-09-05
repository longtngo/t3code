# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

## Attach files

Attach up to eight files per message. Images can be up to 10 MB; other files can
be up to 50 MB, subject to the environment's upload support and limit. The agent
receives them on the environment's machine.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the iOS photo library;
the image limit applies after conversion. On mobile, you can also send files to
T3 Code through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

## Model defaults

T3 Code remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Undoing a message you already sent

Where your provider supports rolling back a conversation, a message you sent shows an undo button
beside its timestamp once the agent's work on it has been checkpointed. It rolls the thread and the
working tree back to the state just before you sent that message, discarding everything the agent
did in response. Confirm first: the change cannot be undone.

Your original text comes back in the composer once the revert lands, so you can reword it and send
again. Anything already typed is kept, and the recalled text is added below it. Attachments are not
restored; if the message had files, attach them again before sending.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft.

Transcription runs on your device. T3 Code deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

Provider commands must start the message to run. T3 Code commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

Each message shows its timestamp and its Copy and Revert buttons when you hover over it. To keep
them visible, turn on **Always show message timestamps** in **Settings → General**.

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
On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your T3 Code session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens the system chooser.

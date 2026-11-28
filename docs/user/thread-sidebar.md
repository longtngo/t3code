# Working with threads

Use a separate thread for each task. Choose **New worktree** when a task needs its own Git branch and working directory; threads sharing a checkout share its branch, so T3 Code blocks branch switches while one is running.

## Start a thread

- **Web and desktop**: **New thread** opens the project picker when you have multiple open projects (unless the sidebar is filtered to one project). `Shift`-click to start in the current project. To reuse an existing worktree, choose **New thread in this worktree** from the branch toolbar.
- **Mobile**: **New thread** uses the current, filtered, or last-opened project. Disable **Settings → General → Use last project** to pick every time.
- **Defaults**: New threads inherit your last model and mode unless the project sets its own model default.

### Start without a project

Threads don't require a project. Pick **No project** (or press `mod+alt+n` on web/desktop) to start a scratch thread in `~/.t3/scratch/<date>-<slug>-<id>`.

- Deleting a scratch thread leaves its folder on disk.
- Git branch, worktree, and diff controls are hidden (and scratch threads are unavailable if your T3 data directory itself is inside a Git repo).
- Choose **Turn into project** from the thread menu to promote the folder into a real project in place, then **Initialize Git** if needed.

### Start in the background and multi-model runs

- **Background start** (web/desktop): Press `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) in a new thread to submit it and immediately open another draft with the same workspace mode and base branch.
- **Same prompt, multiple models** (web/desktop, Git projects): `Shift`-click models in a new thread's model picker to select several. Sending starts a separate thread and worktree for each model.

## Sidebar layout and organization

- **Resize or hide** (web/desktop): Drag the sidebar's right edge past its minimum width to hide it; hover the left window edge and click or drag the handle to bring it back.
- **Drop files onto a thread** (web/desktop): Drag files from your computer onto any thread row to open it and attach them to its composer.
- **Pin and reorder**: Pin a thread from its menu (on web and desktop, also from the pin button that appears when you hover or focus its card), or drag threads between **Pinned**, **Active**, and **Settled** (or drag out of **Snoozed** to wake). On web and desktop, dropping a thread on the **Snoozed** shelf snoozes it for an hour; with nothing snoozed, an empty **Snoozed** box opens above **Settled** while you drag, or at the end of the list when there is no room. The dragged row names its action, including **Snooze 1h** and **Move to** a section. On mobile, use **Arrange threads** or **Move up / Move down** in the thread menu. Custom order syncs across devices (requires an up-to-date server).
- **Undo** (web/desktop): Unpinning, settling, snoozing, archiving, or discarding a draft shows a 5-second **Undo** toast (`mod+z`).
- **Titles**: Choose **Regenerate title** from a thread's menu, or customize title style in **Settings → Threads → Text generation → Thread title instructions** (global or per-project).

### Working section (beta)

Enabled by default (**Settings → General → Working section**, per device). Unpinned threads that are actively running—or waiting on subagents, watched PRs, or monitors—collapse into a **Working** section below Active, and return to the top of Active when they finish, fail, or need input.

While enabled, Active is sorted by most recent return (manual reordering is paused until you turn it off).

### Group threads by project (beta)

Enable **Settings → Labs → Boring sidebar (group by project)** on web/desktop (per device) to group active threads into collapsible project folders. Pinned threads stay above; Snoozed and Settled stay below. In this mode, the Working section and sidebar drag-reordering are disabled (dragging a thread onto the composer still works).

## Organize threads into sections

On web and desktop, click **New section** at the top of the sidebar, or run **New sidebar
section** from the command palette, and give it a name. Sections appear below your active
threads in the order you created them, and each one collapses on its own.

To move a thread in, open its menu and choose **Move to section**. **Move to Active**, or
dragging the thread into the active list, takes it out again. A queued thread you drag from the
Queue to Active goes back to its section. A thread in a section works like
an active thread: pinning, settling, or snoozing it shows it there instead, and unpinning,
un-settling, or waking it returns it to its section. With **Working section (beta)** on, a
working thread stays in its section. Drag a thread among a section's threads to move it there,
or onto its header when the section is collapsed or empty; this also unpins, un-settles, or wakes it.

Right-click a section's header, or use the **…** button on it, to rename or delete it, or run
**Rename sidebar section** or **Delete sidebar section** from the command palette. Deleting a
section moves its threads back to Active. Sections are saved on the machine running your main
T3 Code server and appear on web and desktop clients that use it as their main server. On
app.t3.codes, or on a desktop app that added that server as a remote, its threads show in Active.
Sections are not on mobile yet.

## Queue work for later

On web and desktop, the **Queue** section holds threads that should start when a slot
frees up. Add a thread with **Add to queue** from its menu, drag its row onto
the **Queue** header, or use the queue button or the right-click (long-press on a phone)
menu on a new-thread draft. Drag queued rows to change their order, and type in a queued
thread's composer as usual. Drag a queued thread into any section
to take it out of the queue there; the dragged row shows **Unqueue** when the drop only
returns it to where it was. Dropping a queued thread on **Snoozed** snoozes it and takes it out of
the queue; **Undo** puts it back at the end. Dropping a snoozed thread on the **Queue** header wakes
it and queues it (**Wake & queue**).

The number on the **Queue** header is its active slots. Queued threads send, top first,
while fewer threads are working or watching background work than that number. A queued
thread that is already working is skipped until it finishes. Set the number from the gear
button or **Settings → Queue**; **0** holds the queue and the header reads **Paused**. Turn
on **Per provider** to give each enabled provider its own slots, and hover the number to see
the split.

A queued thread sends its composer message as if you had pressed Send, then returns to
active work. A queued thread with an empty composer returns without sending. Sending it
yourself also takes it out of the queue.

The queue and its slot numbers are kept by the server serving your web app, or the desktop
app's local environment, and shared by its clients; app.t3.codes and a desktop app with its
local environment turned off keep their own. Each queued thread sends from the device that
queued it, while T3 Code is open there. Other devices mark it as queued on another device
and can reorder or remove it; typing in that thread on another device does not change what it
sends. Threads queued on a device before the queue was shared are not moved into it; add them
again.

Use the pause button on the **Queue** header to hold the queue. If a queued send fails, or
needs something only the open thread can do (attachments, a slash command, an answer to a
question), the thread returns to active work with the reason and the queue pauses until you
resume it.

## Settle, snooze, and archive

| Action      | When to use          | Effect                                                                                                                                         |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settle**  | Task is done for now | Moves to **Settled**; stays searchable; any new message reactivates it. Closes idle terminals (and stops actions with `stopOnSettle: true`).   |
| **Snooze**  | Defer until later    | Hides until wake time (thread keeps working in the background). Wakes early on approvals, questions, errors, or new messages.                  |
| **Archive** | Out of the way       | Leaves sidebar and search; lives in **Settings → Archive**. Refuses new messages (including from agents and scheduled tasks) until unarchived. |

> Tip: If a scheduled task targets a thread, settle it instead of archiving—archiving causes scheduled runs to fail.

### Settlement rules and hooks

- **Automatic settlement**: By default, environments settle threads after 7 days of inactivity or when their linked PR merges/closes (even while your apps are closed). Active work, pending questions/approvals, and waited-on background work block auto-settlement. Configure rules in **Settings → Threads** (per environment or **All environments**), including **Keep threads with a PR**.
- **Per-thread override**: Open a thread's menu → **Auto-settle behavior → Never** to exempt a single thread.
- **Drag-to-settle** (web/desktop): Press and drag down/up from a thread's **Settle**, **Un-settle**, or **Wake** button to act on a contiguous range (`Esc` cancels).
- **Offline settle/snooze**: Queues locally (**Pending** / **Waiting to sync**) and syncs on reconnect; remote changes take precedence if the thread changed in the meantime.
- **Worktree cleanup on settle**: Enable **Run in the thread's worktree when the thread settles** on a project action (or `"runOnSettle": true` in `t3.json`), e.g. `cargo clean`, to reclaim disk space automatically in worktree threads.

### Snooze options

Customize presets in **Settings → Threads → Snooze options** (durations like `3 hours` or times like `9:00 PM tomorrow`), or pick **Snooze → Custom…** for an exact date/time or duration. **Snooze → Indefinitely** keeps a thread snoozed until you wake it (it still wakes early on approvals, questions, errors, or new messages). Choose **Wake thread** to bring a thread back early.

## Link a pull request

The server automatically links open PRs matching an unsettled thread's branch. On web/desktop, right-click any PR link in a thread and choose **Link to thread** or **Unlink from thread** to override it. Linked PRs participate in auto-settlement.

## Find and reference work

- **Command palette** (`Cmd/Ctrl+K`): Searches threads across connected environments by title, branch, PR, project, and message contents (use `"exact phrase"` for exact matches). On mobile, use the thread list search (or `Cmd+K` on iPad with a keyboard).
- **Copy reference**: Copies the linked PR URL if one exists, otherwise a thread link that pastes into any composer as a thread chip. Use **Copy → Thread** (or **Copy thread** on mobile) to force a thread link, or **Thread ID** for scripts and the `t3` CLI.

## Usage limits, subagents, and thread details

- **Usage limits**: When a provider hits a rate/usage limit (**Limited**), press **Resume** in an empty composer after reset (or send a message). If the provider reports a reset time, choose **Resume at reset** or **Snooze until reset**—or enable defaults in **Settings → Threads** (**Resume after usage limits** / **Snooze until limits reset**).
- **Subagents**: Follow delegated work from the conversation card or **Agents**. Stopping a parent thread also stops its delegated subagents. Subagents started internally by the provider are read-only; message the parent thread instead.
- **Running dev servers** (web/desktop): The thread details card lists local servers started by the thread's terminals or Claude agent with their ports. Click one to open it in the browser panel, or **Stop** to end it (macOS/Linux only).
- **Customize thread details**: Right-click the thread details card or open **Settings → Appearance → Thread details** to show/hide rows.

## Open a thread beside the one you are in

On web and desktop, subagents, side chats, and [threads on linked machines](./remote-access.md#read-a-linked-machines-threads) open as a tab in the right panel by default so your main thread stays visible.

- Hold `Cmd`/`Ctrl` while clicking (or middle-click) to open in the main view instead.
- Change the default in **Settings → Chat → Open subagents and side chats in**.
- From a right-panel tab, choose **Open in main view** to promote it.
- On mobile, they open in the inspector where available, or full screen otherwise.

## Side chats

Ask a quick side question about a thread without polluting its history. A side chat starts with the parent thread's context, folder, model, and permissions while the parent keeps working.

- **Start** (web/desktop): Send `/side <question>` or `/btw <question>`, or choose **Side chat** from the right panel's **+** menu.
- **Find later**: Listed under **Side chats** in thread details (web/desktop) or above the composer (mobile); hidden from the main sidebar.
- **Bring results back**: Click **Add to chat** in the side chat, or `@`-mention its title in the parent composer (not readable by external OpenCode servers).
- **Lifecycle**: Closing an unused side chat deletes it. Deleting or archiving the parent thread deletes or archives its side chats.

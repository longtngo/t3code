# Notifications

T3 Code can tell you when an agent finishes, fails, or needs an answer, so you
can start work and walk away. Settings → **Notifications** controls both how
those alerts reach you and which ones are worth raising.

## Delivery

Two switches decide whether this device receives anything at all.

- **Task completion notifications** raises a system notification while the app
  is open and you are not already looking at the thread that finished.
- **Background notifications on this device** keeps alerts coming when the app
  is closed or the screen is off. It appears only where the browser supports it,
  and applies to the device you turn it on from — enabling it on your phone does
  not enable it on your laptop.

## Choosing what to be told about

Below the delivery switches, four categories decide which events deserve an
alert. All of them start on, and they apply to every device connected to this
environment.

| Category                   | Raised when                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task finished**          | A task stopped running and nothing was left working in the background. This is the alert that means a whole piece of work is done.             |
| **Interim finish**         | A task stopped running while subagents or other background work were still going.                                                              |
| **Agent asked a question** | An agent is waiting on an answer before it can continue. Only background notifications raise this one, so it has no effect in the desktop app. |
| **Task failed**            | A task stopped because of an error.                                                                                                            |

### If you are getting too many notifications

Turn off **Interim finish** first.

An agent that hands work to subagents does not run start-to-finish in one go. It
settles, waits for a subagent to report back, wakes up, settles again — and each
of those settles is a finish. On a busy setup those interim finishes are the
large majority of the alerts you receive, and none of them mean the work is done.

Turning them off is safe: the split is based on whether anything was still
running at that moment, not on what woke the agent up. At the true end of a run
nothing is left working, so the final alert lands in **Task finished** and still
reaches you.

Leaving **Task failed** and **Agent asked a question** on is worth it. Both are
rare, and both are the kind of thing you want to hear about immediately —
a failure you would otherwise discover much later, or an agent sitting idle
waiting on you.

## If notifications never arrive

- Check that your browser or system has not blocked notifications for T3 Code.
  The delivery switches cannot override an operating-system permission.
- Background notifications need the app installed or open in a supported
  browser over a secure connection. They are not available in the desktop app,
  which uses system notifications directly instead.
- Confirm the categories you expect are still switched on. A category turned off
  on one device is off everywhere on that environment.

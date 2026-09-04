# Running work in parallel with crew

Crew lets one thread hand work to other agent threads, called crewmates. Each crewmate gets its own
branch and its own git worktree, so several of them can work at once without touching each other's
files. The thread that dispatched them is called the bridge, and finished work comes back to it.

Crew is off until you turn it on. Enable it in **Settings → General → Crew**.

## Dispatching

With crew on, ask the agent in any thread to dispatch a crewmate and describe the task. The
crewmate starts in a fresh worktree branched from the base you name, or from the current branch if
you do not name one. A crewmate cannot dispatch crew of its own.

There is a limit on how many crewmates can run at once. When you reach it, dispatching is refused
until you tear one down. Crew also refuses to start when free disk space is low, since every
crewmate needs a worktree.

## Following along

The **Crew** panel lists every task, its state, and anything a crewmate has said. Crewmates report
progress as they go, and report again when they finish or fail. Those reports arrive in the thread
that dispatched them, so you can stay in one conversation.

A crewmate that needs a decision stops and asks. The panel shows the question with an **Answer**
button. Answering unblocks it and it carries on.

## Finishing up

Tear a task down from the Crew panel when you are done with it. Teardown closes the task, stops the
crewmate's session, and frees its slot. The branch and its commits are left alone, so you can review
or merge the work afterwards.

## Turning crew off

Turning the switch off stops new crewmates being dispatched. Anything already running keeps going,
and the Crew panel keeps working, so you can still answer a waiting crewmate or tear one down.

While crew is off, progress reports stop interrupting your threads. They are not lost: they arrive
the next time you turn crew on. Answers you send are still delivered straight away, because a
crewmate waiting on one cannot do anything else until it arrives.

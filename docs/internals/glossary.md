# Glossary

Terms whose meaning matters across T3 Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Fork additions

Concepts this fork adds on top of upstream. Sources: [SubagentBackend.ts](../../apps/server/src/subagentBackend/SubagentBackend.ts),
[ThreadBackendPath.ts](../../apps/server/src/subagentBackend/ThreadBackendPath.ts),
[CrewService.ts](../../apps/server/src/crew/CrewService.ts), [CrewSweep.ts](../../apps/server/src/crew/CrewSweep.ts).

| Term              | Meaning                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagent offload  | Where a coding agent dispatches its subagents, chosen per machine and per thread. Resolution order: master switch, then thread mode (`inherit`/`on`/`off`), then the machine-global record.        |
| Crew              | The set of agent threads one thread dispatched to work in parallel, each in its own git worktree. Off by default behind the `enableCrew` server setting.                                           |
| Crewmate          | A thread dispatched by another thread. Runs its own provider session on its own branch and worktree, and reports back through `crew_report`. It may not dispatch its own crew; nesting is refused. |
| Bridge            | The thread that dispatched a crewmate. Reports flow crewmate to bridge, answers flow bridge to crewmate. A thread's `crewRole` is derived from task rows, not stored on the thread.                |
| Delivery sweep    | The 60s pass that carries reports to their destination and stamps them handled. While `enableCrew` is off it narrows to answers only, and forks a zombie scan that is deliberately not gated.      |
| Environment theme | A per-environment colour applied across clients so multiple connected environments stay visually distinct.                                                                                         |

## Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The reactor that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.               |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

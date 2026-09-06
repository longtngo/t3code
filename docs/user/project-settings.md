# Project settings

Open **Settings → Projects**. The project and machine pickers start at **All projects** and
**All machines**.

Change the default model, workspace, automatic pull, agent browser access, or actions for projects that inherit those values.
Select an individual project to override a default. Reset its row to inherit again. Changing a
default preserves explicit project overrides. Workspace preferences in `t3.json` take precedence
over machine defaults when the project has no explicit workspace override.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. Mixed values are indicated when selected machines
or checkouts disagree. Browser access changes apply when an agent session next starts.

Project grouping has a client-wide default across machines, with individual checkout overrides.
Shared actions apply to inheriting projects; editing a project's actions creates an independent list.
Reset that list to use shared actions again. Existing project actions are preserved.

Project names, icons, removal, and importing actions from a checkout remain project-specific.
When there are several checkouts, the checkout picker selects which actions and grouping to edit.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to selected checkouts in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Workspace repositories

A project is rooted at one checkout, but work often spans more than one repository. Attach the
others under **Settings → Projects → Workspace repositories**, or from a project's context menu in
the sidebar. Threads in that project can then read and write them. Attachments belong to the
individual checkout, not to the project group.

Give each one a path and an **integration branch**: the branch it normally sits on. Attach the
repository wherever it already lives. T3 Code does not clone or move it, and **Detach** only
removes the attachment, never anything on disk.

A bar above the composer lists the attached repositories. T3 Code leaves each one on its
integration branch until a turn changes a file git already tracks there, then cuts a branch and
records that this thread owns it. Untracked files are ignored on purpose, so a stray note or build
artifact does not pull a repository into every thread.

An attached repository is one shared checkout, so two threads cannot each have their own copy:

- If another thread already owns the branch a repository is on, the composer warns you before you
  send. Sending anyway writes into that thread's work.
- A repository you put on a branch yourself is shown but never moved, and so is one with a
  detached HEAD. T3 Code only manages branches it cut.
- A path that has gone missing, or is no longer a repository, is marked unavailable. The rest keep
  working.

A pull request from an attached repository compares against the branch it was cut from rather than
its integration branch, so a hotfix cut from `main` in a repository pinned to a release branch
opens against `main`. Confirm the base offered; it is only remembered once you have.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

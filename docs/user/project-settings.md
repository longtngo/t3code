# Settings and project overrides

The Settings breadcrumb ends with the environment and project a change applies to. They start
at **All environments** and **All projects** and stay selected as you move between categories or
search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

For workspace mode, a project's `t3.json` preference applies when the project has no override.
Browser access changes apply when an agent session next starts.

## Project icons

Select the project and open Project to choose an icon, emoji, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

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

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

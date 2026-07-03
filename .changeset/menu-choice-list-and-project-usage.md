---
'anon-pi': minor
---

Add the pure bare-launch menu choice-list + per-machine project-usage record to
`src/anon-pi.ts` (the data the host-side menu renders; the TUI is a later task).

- `projectSessionSlug(name)`: the pi session-dir slug for a project, i.e.
  `pathSlug` of its jail cwd `/projects/<name>`. It is MACHINE-INVARIANT (the
  cwd is the same on every machine, since files are global), so the same shared
  project is recognised in each machine's `sessions/` dir. Matches pi's own
  session-manager convention (`--projects-<name>--`).
- `buildMenuChoiceList({projects, canNew?, canShell?})` -> `MenuChoiceList`
  `{ projects, here, canNew, canShell }`: computed from a SUPPLIED projects-root
  listing. Non-project entries (dotfiles, `..`, separators, whitespace, reserved
  tokens) are dropped; surviving names are sorted case-insensitively for a
  stable menu; `here` is the `.` root token (a scratch pi at the root itself);
  `canNew` / `canShell` default true (affordance gates for later policy).
- `deriveProjectUsage({projects, currentMachine, sessions})` -> `ProjectUsage[]`
  `{ project, machines, currentMachineIsNew }`: DERIVED from a SUPPLIED
  per-machine session-dir listing (`SessionDirListing`, no marker file). Each
  project maps to the (sorted) machines whose home contains its session slug,
  preserving the supplied project order; `currentMachineIsNew` is true when the
  current machine has no session dir for the project yet.

Pure and additive (no filesystem side effects): the CLI reads the real projects
root + each machine home's `sessions/` dir and renders the menu in a later task.

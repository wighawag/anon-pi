---
title: Menu choice-list + per-machine project-usage record (derived from session dirs)
slug: menu-choice-list-and-project-usage
prd: machines-and-projects-workspace
blockedBy: [machine-and-project-resolvers]
covers: [1, 2, 10]
---

## What to build

The pure data the bare-launch menu renders: the choice-list of a machine's
projects (plus "new project" and "shell"), and the per-machine project-usage
record that annotates each project with the machines it has been used on.

In the pure module (`src/anon-pi.ts`), deliver:

- **The menu choice-list** `{ projects, canShell, canNew }` computed purely from
  a supplied listing of the host projects root (the projects each map to a pi
  launch; plus a "+ new project…" and a "shell" affordance, and a `.` "here"
  entry for a scratch pi at the root).
- **The per-machine project-usage record**: for each project, which machines have
  used it, DERIVED from the presence of pi session dirs
  (`machines/<M>/home/.pi/agent/sessions/<slug>/`) — NO marker file. The slug is
  pi's own cwd convention over `/projects/<name>` (machine-invariant), so usage
  is inferred from which machine homes contain that session dir.
- A flag for whether the CURRENT machine is NEW for a given project (no session
  dir yet in the current machine's home).

Feed the resolvers with SUPPLIED listings (project names, per-machine session-dir
presence) so the module stays pure; the CLI does the real directory reads and the
TUI rendering.

## Acceptance criteria

- [ ] `{ projects, canShell, canNew }` (plus the `.` "here" entry) is computed
      from a supplied projects-root listing.
- [ ] The project-usage record maps each project → the machines that have used it,
      derived from session-dir presence (`.../sessions/<slug>/`), no marker file.
- [ ] The slug used to key sessions is pi's cwd convention over
      `/projects/<name>` (machine-invariant), so the SAME project shared across
      machines is recognised on each.
- [ ] A "current machine is new for this project" flag is exposed.
- [ ] Tests cover the new behaviour against a FIXTURE
      `machines/*/home/.pi/agent/sessions/` tree (mirror existing pure-module test
      style): choice-list shape, usage derivation, and the current-machine-new
      flag.
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] Tests ISOLATE all reads against fixture dirs; no real `~/.anon-pi` is
      touched.

## Blocked by

- `machine-and-project-resolvers` (needs the project resolver + the
  `/projects/<name>` cwd → session slug convention; shares `src/anon-pi.ts`).

## Prompt

> FIRST, check this task against current reality: confirm the project resolver +
> the `/projects/<name>` cwd/session-slug convention landed. If the slug
> convention differs from what this assumes, adapt or route to needs-attention —
> the usage derivation depends on matching pi's real session-dir naming.

anon-pi's bare launch shows a HOST-side arrow-key menu of a machine's projects
before any jail runs. Conversations are per-machine (each machine's home keeps
its own pi sessions), but project FILES are global (the same folder is shared
across machines). pi keys a session by its launch cwd, so a project used on a
machine leaves a session dir at `machines/<M>/home/.pi/agent/sessions/<slug>/`,
where `<slug>` is pi's cwd convention over `/projects/<name>` (machine-invariant).

Goal: add, in `src/anon-pi.ts`, the pure menu choice-list `{ projects, canShell,
canNew }` (plus a `.` "here" entry) computed from a supplied projects-root
listing, AND the per-machine project-usage record derived from session-dir
presence (NO marker file), including a "current machine is new for this project"
flag. Everything pure: supply the listings in; the CLI reads dirs and renders the
TUI (separate task).

Test against a fixture `machines/*/home/.pi/agent/sessions/` tree. "Done" = the
pure choice-list + usage record + tests green under `verify`, with a changeset.
Do NOT build the raw-mode TUI here (that is `cli-menu-tui`).

> RECORD non-obvious in-scope decisions (how usage is displayed/ordered) as a
> `## Decisions` note, or an ADR if it meets the gate.

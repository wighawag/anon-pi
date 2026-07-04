---
title: machine snapshot — copy the home (minus sessions) + per-project session carry-over
slug: snapshot-home-copy-and-session-select
prd: machines-and-projects-workspace
---

## What to build

Extend `machine snapshot` so the new machine is not a bare fresh home but carries
the source machine's home state, with pi conversations handled deliberately.

When snapshotting the running container of source machine `<M>` into `<new-name>`:

1. **Copy the source home ENTIRELY EXCEPT `sessions/`** into the new machine's
   home (config, extensions, downloaded tool binaries, dotfiles, the seed
   marker). This is safe here (and better than a fresh seed) because the new
   image IS the committed source filesystem, so the copied home's
   extensions/binaries are correct-for-the-new-image. No prompt. The new home is
   therefore NOT re-seeded on first launch (it already has the config).
   - Copy path: `machines/<M>/home/` -> `machines/<new-name>/home/`, excluding
     the single subtree `.pi/agent/sessions/`.

2. **Sessions: interactive, grouped BY PROJECT, opt-in per project.** Sessions
   live at `.pi/agent/sessions/<slug>/`, one slug per project (machine-invariant
   `projectSessionSlug`). On a TTY, list each present session group as a PROJECT
   row (project name; an orphan slug with no matching project name is shown by
   its raw slug so nothing is hidden). DEFAULT: all UNSELECTED. Per project the
   user chooses COPY or SKIP. Copy = duplicate that `sessions/<slug>/` dir into
   the new home. There is NO per-row MOVE.
   - Non-TTY: copy NONE (clean, non-blocking scriptable default).

3. **Optional, explicit, destructive "move" step.** AFTER the copies, if any
   session group was copied, ONE confirm (default No): "Also delete the
   just-copied session group(s) from source machine <M>? [y/N]". Yes => remove
   those `sessions/<slug>/` dirs from the SOURCE home. This is the only way to
   "move"; it is separate + confirmed so a live machine's history is never gutted
   by a per-row toggle.

## Pure vs impure

- PURE (`src/anon-pi.ts`): a `snapshotSessionGroups({presentSlugs, projects})`
  that maps the slug dirs present under the source `sessions/` + the known
  project names to labelled rows `{project?, slug, label}` (project row when a
  slug matches `projectSessionSlug(project)`, else an orphan-slug row). Unit
  tested. The home-minus-sessions exclusion path is a documented CLI concern.
- IMPURE (`src/cli.ts`): the recursive home copy with the `sessions/` exclusion,
  the per-project COPY/SKIP picker (TTY only), the session-dir copies, and the
  optional confirmed delete-from-source.

## Acceptance criteria

- [ ] Snapshot copies the source home minus `.pi/agent/sessions/` into the new
      machine's home (config/extensions/dotfiles/seed-marker present; no reseed).
- [ ] On a TTY, the user is offered each session group BY PROJECT (default
      unselected) with a per-project COPY/SKIP choice; SKIP leaves it out.
- [ ] Non-TTY: no sessions are copied (and snapshot does not block).
- [ ] Copied session groups appear in the new home; the source home is unchanged
      UNLESS the user confirms the explicit delete-from-source step (default No).
- [ ] There is NO per-row MOVE; "move" is only the separate confirmed delete.
- [ ] The slug->project row mapping is PURE + unit-tested (project rows + orphan
      slug rows); the CLI copy/prompt wiring is covered with netcage stubbed off
      (hermetic, like the existing snapshot CLI test) OR by testing the pure part
      + a fs-level copy test that does not touch netcage.
- [ ] README + MACHINE_HELP document the home copy + the per-project session
      carry-over + the confirmed move.
- [ ] A changeset (`minor`: snapshot now carries home state).

## Notes / decisions

- Home copy is "everything except sessions" (decided: copy all config, it is
  correct for the committed image). Sessions default UNSELECTED (isolation model:
  a snapshot machine does not silently inherit the source's whole chat history).
- MOVE rejected as a per-row option (irreversible loss from a still-live source
  machine); replaced by one explicit, confirmed, default-No delete-from-source.
- Grouping is BY PROJECT (a `sessions/<slug>/` dir), not by individual session
  file, matching how pi stores them and how the user thinks about it.

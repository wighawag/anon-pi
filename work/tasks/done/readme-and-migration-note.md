---
title: README rewrite + 0.4.0 → machines/projects migration note
slug: readme-and-migration-note
spec: machines-and-projects-workspace
blockedBy: [cli-launch-surface-grammar-a, cli-bare-launch-menu-tui, cli-machine-verbs, cli-data-verbs-delete-home-project, cli-init-onboarding, images-projects-path-rename]
covers: [22]
---

## What to build

Rewrite the README around the new model and add a clear migration note so the
breaking change does not silently surprise a 0.4.0 user.

- Rewrite `README.md` (and any package README) around: **machines** (image +
  persistent home) + **projects** (folders under the projects root) + `anon-pi
  init` + the bare-launch **menu**; the `--shell` project-hopper (pi can't cd
  mid-session, so the shell is how you hop projects); the `--mount` host-parent
  caveat; the throwaway-default (`--rm`) with `--keep` for the exploratory
  kept-container flow; the forced-egress honesty (proxy required, `netcage
  verify` evidence, never labelling the exit provider); env vars as OVERRIDES.
- **Migration note**: a bare positional is now a PROJECT, not a host path
  (`anon-pi ./recon` no longer mounts host `./recon`; host folders use `--mount
  <path>`); `import` / `--fresh` / `--ephemeral` are GONE (→ `init` /
  `--delete-home`/`--delete-project` / `--rm`); old `state/<slug>/` is NOT
  migrated (document deleting it); the new layout is `~/.anon-pi/`
  (`config.json` + `machines/` + `projects/`), not under `~/.config`.

This is a docs task; verify claims against the LANDED behaviour of the CLI tasks
(hence the broad `blockedBy`).

## Acceptance criteria

- [ ] README is rewritten around machines + projects + init + the bare menu +
      `--shell` + `--mount` + throwaway-default/`--keep` + the forced-egress
      honesty + env-as-overrides.
- [ ] A migration note documents: bare positional = PROJECT (not host path);
      `import`/`--fresh`/`--ephemeral` removed and their replacements; old
      `state/<slug>/` not migrated; new `~/.anon-pi/` layout.
- [ ] Claims match the actually-landed CLI behaviour (no aspirational flags).
- [ ] Every change produces a changeset; the `verify` gate passes (README changes
      still need a changeset per AGENTS.md).
- [ ] No shared/global writes (docs-only).

## Blocked by

- The CLI surface tasks (`cli-launch-surface-grammar-a`, `cli-bare-launch-menu-tui`,
  `cli-machine-verbs`, `cli-data-verbs-delete-home-project`, `cli-init-onboarding`)
  and `images-projects-path-rename` — so the README documents the real,
  landed behaviour.

## Prompt

> FIRST, check this task against current reality: read the LANDED CLI behaviour
> (the done tasks + the current `src/cli.ts` help/flags) and document THAT, not
> the prd's aspiration. If a flag/verb landed differently than the prd described,
> document what shipped and note the discrepancy (do not invent flags).

anon-pi has been reworked from its 0.4.0 per-workdir model into a machines +
projects workspace on netcage v0.4.0. Vocabulary (`CONTEXT.md`): **machine**
(image + persistent host home), **project** (folder under the projects root →
`/projects/<name>`), **proxy** (required socks5h, fail-closed), **forced-egress**
(the invariant), kept vs throwaway (`--keep`/`--rm`).

Goal: rewrite `README.md` around the new model — machines + projects + `init` +
the bare-launch menu + the `--shell` project-hopper + the `--mount` host-parent
caveat + throwaway-default/`--keep` + the forced-egress honesty (evidence, never
label the exit provider) + env-as-overrides — and add a clear MIGRATION note for
0.4.0 users (bare positional is now a PROJECT; `import`/`--fresh`/`--ephemeral`
gone; old `state/<slug>/` not migrated; new `~/.anon-pi/` layout). Verify every
claim against the landed CLI (this task is blocked on all the CLI tasks for that
reason).

"Done" = README + migration note accurate to shipped behaviour, tests green under
`verify`, with a changeset (docs changes still need one).

> RECORD any discrepancy you find between the prd and what landed as a
> `work/notes/observations/` note, and document what actually shipped.

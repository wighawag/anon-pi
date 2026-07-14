---
title: CLI data verbs — --delete-home [machine] and --delete-project <project>
slug: cli-data-verbs-delete-home-project
spec: machines-and-projects-workspace
blockedBy: [machine-and-project-resolvers, cli-launch-surface-grammar-a, cli-machine-verbs]
covers: [19]
---

## What to build

The destructive cleanup verbs, replacing the old `--fresh`, with confirmation.

In `src/cli.ts`, using the pure resolvers:

- **`--delete-home [<machine>]`**: delete a machine's HOME (config + convos +
  shell env). Default machine when omitted. Confirm `[y/N]` on TTY, `--yes` to
  skip, abort non-TTY without `--yes`. Leaves projects (their files) untouched.
- **`--delete-project <project>`**: delete the project's FILES (its projects-root
  folder) AND that project's per-machine pi sessions (the `<slug>` session dirs
  across machine homes). Confirm / `--yes` / non-TTY abort. Leaves the rest of
  each home intact.

Resolve the affected paths (machine home, project folder, per-machine session
dirs for the project's `/projects/<name>` slug) via the pure module; the CLI does
the confirm prompt + the actual `rm`. Match the behaviour table in the prd: a
project delete drops that project's sessions everywhere but keeps the homes; a
home delete drops one machine's convos but not the project files.

## Acceptance criteria

- [ ] `--delete-home [<machine>]` deletes the (default or named) machine home with
      confirm / `--yes` / non-TTY abort; project files untouched.
- [ ] `--delete-project <project>` deletes the project's files AND its per-machine
      session dirs (keyed by the `/projects/<name>` slug) across machine homes;
      the rest of each home is kept; confirm / `--yes` / non-TTY abort.
- [ ] The affected-path resolution (home, project folder, per-machine session
      dirs) comes from the pure module; the CLI does confirm + `rm`.
- [ ] Tests cover the new behaviour (mirror `cli-fresh.test.ts` style): each verb
      deletes exactly the right paths and no more, and honours
      confirm/`--yes`/non-TTY.
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] Tests ISOLATE all deletes to a temp anon-pi home and assert the real
      `~/.anon-pi` is untouched.

## Blocked by

- `machine-and-project-resolvers` (the machine-home + project-folder + session
  slug resolvers these verbs target).
- `cli-launch-surface-grammar-a` (the base launch path in the shared `src/cli.ts`).
- `cli-machine-verbs` (the PRECEDING `cli-*` task in the `src/cli.ts` chain: the
  `cli-*` tasks all edit `src/cli.ts`, so they are chained one-after-another to
  avoid parallel same-file conflicts; build on the version machine-verbs landed).

## Prompt

> FIRST, check this task against current reality: confirm the machine/project
> resolvers + the `/projects/<name>` session slug convention landed, and the
> launch surface (shared `src/cli.ts`) is in place. If the session-dir naming
> differs from what this assumes, adapt or route to needs-attention — deleting the
> wrong sessions is a data-loss bug.

anon-pi replaces the old `--fresh` with two scoped, confirmed cleanup verbs. A
**machine home** holds config + conversations; **project** files are global under
the projects root, with per-machine pi sessions keyed by the `/projects/<name>`
cwd slug.

Goal: land `--delete-home [<machine>]` (drop a machine's home; default machine)
and `--delete-project <project>` (drop the project's files AND its per-machine
session dirs across homes) in `src/cli.ts`. Both confirm on TTY, take `--yes`, and
abort non-TTY without `--yes`. Resolve the affected paths via the pure module; the
CLI does the prompt + `rm`. Honour the prd behaviour table: delete-project drops
that project's sessions everywhere but keeps the homes; delete-home drops one
machine's convos but keeps project files.

Test each verb deletes exactly the right paths (and nothing else) against a temp
anon-pi home (assert the real one is untouched), including confirm/`--yes`/non-TTY.
"Done" = both verbs working, tests green under `verify`, with a changeset. Edits
`src/cli.ts` after `cli-launch-surface-grammar-a` (serialized).

> RECORD non-obvious in-scope decisions (what "the project's sessions" precisely
> matches) as a `## Decisions` note, or an ADR if it meets the gate.

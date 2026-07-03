---
title: CLI machine verbs — create / list / set-image / rm
slug: cli-machine-verbs
prd: machines-and-projects-workspace
blockedBy: [machine-and-project-resolvers, cli-launch-surface-grammar-a]
covers: [8, 9, 18]
---

## What to build

The `anon-pi machine {create,list,set-image,rm}` subcommands that make machines
first-class, built on the pure machine resolvers.

In `src/cli.ts` (dispatch) using the pure resolvers/validators:

- **`machine create <name> [--image <ref>]`**: validate the name, create
  `machines/<name>/{machine.json,home/}`, pin the image (from `--image` or a
  prompt). The home is seeded on first LAUNCH (not here).
- **`machine list`**: list machines and their pinned images (reads
  `machines/*/machine.json`).
- **`machine set-image <name> <ref>`**: RE-PIN the image and WARN only (the home's
  extensions/bin were built for the old image; suggest re-running `pi install`
  or `--delete-home` if they misbehave). No auto-reseed. This is the one explicit
  place an image changes.
- **`machine rm <name> [--yes]`**: delete the machine (its `machine.json` + home).
  Confirm on TTY; abort non-TTY without `--yes`.

Keep dispatch thin; the name validation, path resolution, and any decision logic
come from the pure module. Destructive `rm` mirrors the data-verbs
confirm/`--yes`/non-TTY discipline.

## Acceptance criteria

- [ ] `machine create <name> [--image <ref>]` validates the name and writes
      `machines/<name>/machine.json` + `home/`; image from `--image` or prompt.
- [ ] `machine list` prints machines + their images.
- [ ] `machine set-image <name> <ref>` re-pins the image and prints the
      compatibility WARNING; it does NOT reseed or touch the home.
- [ ] `machine rm <name>` deletes the machine + home with confirmation (TTY),
      `--yes` to skip, non-TTY abort without `--yes`.
- [ ] Tests cover the verbs at their seams (mirror existing `cli-*.test.ts`
      style): create writes the right layout, list reads it, set-image warns +
      leaves home intact, rm honours confirm/`--yes`/non-TTY.
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] Tests ISOLATE writes to a temp anon-pi home and assert the real
      `~/.anon-pi` is untouched (create/rm write to a real workspace dir).

## Blocked by

- `machine-and-project-resolvers` (the machine dir/home/`machine.json`
  resolvers + name validation these verbs call).
- `cli-launch-surface-grammar-a` (shared `src/cli.ts`; serialized to avoid
  conflicts).

## Prompt

> FIRST, check this task against current reality: confirm the machine resolvers +
> name validation landed and that the launch surface (which shares `src/cli.ts`)
> is in place. If the resolver/`machine.json` shape differs, adapt or route to
> needs-attention.

A **machine** in anon-pi is an image + a persistent host **home**
(`machines/<M>/{machine.json,home/}`); machines own their image (a project needing
a different image runs on a different machine). Machines are first-class and
managed by verbs.

Goal: land `anon-pi machine {create,list,set-image,rm}` in `src/cli.ts`, using the
pure machine resolvers + name validation. `create` writes the machine layout and
pins the image (home seeded on first LAUNCH, not here). `list` prints machines +
images. `set-image` RE-PINS and WARNS only (no auto-reseed; the home was built for
the old image). `rm` deletes machine + home with confirm / `--yes` / non-TTY
abort. Keep dispatch thin; logic/validation live in the pure module.

Test each verb at its seam against a temp anon-pi home (assert the real one is
untouched). "Done" = the four verbs working, tests green under `verify`, with a
changeset. Edits `src/cli.ts` after `cli-launch-surface-grammar-a` (serialized).

> RECORD non-obvious in-scope decisions (set-image warning wording, rm scope) as a
> `## Decisions` note, or an ADR if it meets the gate.

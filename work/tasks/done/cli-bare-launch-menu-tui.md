---
title: CLI bare-launch menu (host-side arrow-key TUI)
slug: cli-bare-launch-menu-tui
spec: machines-and-projects-workspace
blockedBy: [menu-choice-list-and-project-usage, cli-launch-surface-grammar-a, cli-init-onboarding]
covers: [1, 2, 16]
---

## What to build

The interactive, host-side arrow-key menu that bare `anon-pi` (and bare `-m
<machine>`) shows before any jail runs, driven by the pure choice-list +
project-usage record.

In `src/cli.ts`:

- Render a **hand-rolled, zero-dependency** arrow-key selector (raw-mode stdin:
  up/down/enter/Ctrl-C, a `>` cursor + highlighted active row, restore the
  terminal on exit). A small supply-chain surface is on-brand for a security
  tool; the project list is short. Keep it isolated (a `select()` function) so a
  well-regarded prompt lib could swap in later as a localized change if the
  hand-rolled result is not clean.
- Populate it from the pure choice-list `{ projects, canShell, canNew }` + the
  `.` "here" entry, ANNOTATING each project with the machines it has been used on
  and flagging whether the current machine is new for it (the pure usage record).
- On selection: a project → the same launch as `anon-pi <project>` (pi in
  `/projects/<name>`); `+ new project…` → prompt a name (validated) → pi there;
  `shell` → the `--shell` launch; `.`/"here" → a scratch pi at the root.
- The menu is a PURE HOST-side read (projects root + each machine's session
  dirs); no jail runs until the user chooses. No-TTY → the error the launch task
  already emits for bare `anon-pi`.

The menu is the ONLY untested I/O (rendering/selection); the choice-list + usage
data it renders is already unit-tested in the pure module. Keep no logic in the
TUI.

## Acceptance criteria

- [ ] Bare `anon-pi` (and bare `-m <machine>`) shows the arrow-key menu of the
      machine's projects + `+ new project…` + `shell` + a `.`/"here" entry.
- [ ] Each project row is annotated with the machines it has been used on and
      flags whether the current machine is new for it.
- [ ] Selecting a project launches pi identically to `anon-pi <project>`; `+ new
      project…` prompts+validates a name then launches; `shell` launches
      `--shell`; "here" launches a scratch pi at the root.
- [ ] The terminal is restored on exit/Ctrl-C; no-TTY yields the bare-launch error
      (not a crash).
- [ ] Tests cover the choice-list + usage inputs at the pure seam (already
      unit-tested); the raw-mode render/select stays thin/untested. No new logic
      lands in the TUI.
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] Any dir reads in tests are isolated to fixtures; the real `~/.anon-pi` is
      untouched.

## Blocked by

- `menu-choice-list-and-project-usage` (the pure choice-list + usage record it
  renders).
- `cli-launch-surface-grammar-a` (the launch entry points selections dispatch to,
  and the base of the shared `src/cli.ts`).
- `cli-init-onboarding` (the PRECEDING `cli-*` task in the `src/cli.ts` chain: the
  `cli-*` tasks all edit `src/cli.ts`, so they are chained one-after-another to
  avoid parallel same-file conflicts; this is the LAST link, so build on its
  version).

## Prompt

> FIRST, check this task against current reality: confirm the pure menu
> choice-list + project-usage record landed, and that the launch surface exposes
> the `<project>` / `--shell` / new-project entry points the menu dispatches to.
> If the choice-list shape or launch hooks differ, adapt or route to
> needs-attention.

anon-pi's bare launch is a HOST-side arrow-key menu (no jail runs until the user
picks). Conversations are per-machine; project files are global — so the menu
annotates each project with the machines it has been used on (derived, no marker
file) and flags whether the current machine is new for it.

Goal: land the interactive menu in `src/cli.ts`. Prefer a HAND-ROLLED,
zero-dependency raw-mode selector (up/down/enter/Ctrl-C, `>` cursor, highlighted
row, terminal restored on exit), isolated in a `select()` function so a lib could
swap in later. Feed it the PURE choice-list `{ projects, canShell, canNew }` + `.`
"here" entry + the usage annotations. Dispatch selections to the existing launch
entry points (project → pi in `/projects/<name>`, new project → prompt+validate →
pi, shell → `--shell`, here → scratch pi at root). No-TTY reuses the bare-launch
error. Keep ALL logic in the pure module; the TUI is the only untested I/O.

"Done" = bare `anon-pi` and bare `-m <machine>` present the menu and launch the
right thing on selection, tests green under `verify`, with a changeset. This task
edits `src/cli.ts` after `cli-launch-surface-grammar-a` (serialized to avoid
conflicts).

> RECORD non-obvious in-scope decisions (annotation formatting, key handling) as a
> `## Decisions` note, or an ADR if it meets the gate.

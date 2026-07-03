---
title: CLI launch surface (grammar A) — parse, run-vs-start query, spawn netcage
slug: cli-launch-surface-grammar-a
prd: machines-and-projects-workspace
blockedBy: [launch-run-plan-resolution, run-vs-start-kept-container-decision, models-json-generation-from-llm]
covers: [3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 16, 20]
---

## What to build

The thin impure launch path in `src/cli.ts` that parses grammar A, resolves the
RunPlan (pure), decides run-vs-start against real netcage, and spawns with
inherited stdio — preserving forced egress.

In `src/cli.ts`:

- **Parse grammar A**: a bare positional is a PROJECT; `-m <machine>` picks the
  machine; `--shell [<project>]` → jailed bash; `--mount <parent> [<project>]` →
  host-parent root; `--rm` (implicit default) / `--keep`; the `.` root token;
  trailing `<pi-args…>` after the project are forwarded to pi. Enforce NAME vs
  `--mount` exclusivity and the reserved-name guard (via the pure validators).
- **No-TTY discipline**: bare `anon-pi` (menu) and interactive pi require a TTY →
  error clearly if absent; `anon-pi <project> <pi-args…>` (headless) does NOT
  require a TTY.
- Create the needed host dirs (machine home, projects-root subfolder) before
  spawn; run the seed-if-fresh path via the RunPlan's container cmd.
- **Run-vs-start**: on `--keep`, call the netcage query (the impure seam from the
  decision task) to find a kept `netcage.managed` container and `netcage start`
  it, else `netcage run` without `--rm`; `--rm` always `netcage run --rm`.
- Spawn `netcage` with inherited stdio (real interactive TTY); propagate its exit
  code. The composed argv ALWAYS carries `--proxy` + the one `--allow-direct`
  (forced egress) — the RunPlan guarantees it; the CLI must not strip or add
  egress.

Drop the old `runLaunch` per-workdir path, `--ephemeral`/`--fresh`, and the
`import` subcommand dispatch (its replacement `init` is a separate task; leave a
clear "unknown command" until then, or land alongside). Keep the TUI (menu) out
of THIS task — bare launch dispatches to the menu task's entry point (add a
stub/hook so this task can land with `<project>`/`--shell` working and the menu
wired in next).

**This task STOPS calling the old surface but does NOT delete the pure symbols.**
It rewrites `cli.ts` onto the new RunPlan resolver + models.json generator (which
already exist alongside the old symbols), and owns the BEHAVIOURAL removals that
belong to the CLI change:

- the `HELP` string (rewrite to the new model, dropping
  `import`/`--fresh`/`--ephemeral`/the per-workdir docs);
- `cli-fresh.test.ts` and any CLI test asserting the removed
  `--ephemeral`/`import`/per-workdir flags (these go red the moment the flow is
  gone, so they are retired here).

After this task, `cli.ts` no longer reads the old pure symbols
(`buildRunPlan`/`stateAgentDir`/`resolveConfigSeed`/`pickProviderForLlm`/
`resolveSourceModelsPath`) or the dead `AnonPiEnv`/`envFromProcess` fields, but it
LEAVES them defined-and-exported in `anon-pi.ts` (still green: they compile and
their `anon-pi.test.ts` blocks still pass). Their DELETION is a separate follow-on
task, `retire-legacy-pure-surface`, which is `blockedBy` this one and runs after
the reader is gone. That keeps each task single-purpose while the build stays
green at every step. (The container-path CONSTANT rename to `/projects` was
already done by `launch-run-plan-resolution`.)

## Acceptance criteria

- [ ] Grammar A parses: bare positional = project; `-m` = machine; `--shell
      [p]`; `--mount <parent> [p]`; `--keep`/`--rm`; `.`; forwarded `<pi-args…>`.
- [ ] NAME vs `--mount` exclusivity and reserved/invalid names are rejected with a
      clear error (via the pure validators).
- [ ] No-TTY: bare `anon-pi` errors; `<project> <pi-args…>` runs without a TTY.
- [ ] `--keep` resumes a kept `netcage.managed` container via `netcage start`
      when present (using the decision seam), else `netcage run` (no `--rm`);
      `--rm`/default is `netcage run --rm`.
- [ ] The spawned argv always includes `--proxy` + the single `--allow-direct`
      (forced egress); no path strips it.
- [ ] `--ephemeral`/`--fresh`/`import`/the per-workdir slug model are removed from
      the `cli.ts` launch path, AND their tests are retired: `cli-fresh.test.ts`
      is deleted/rewritten and no CLI test still asserts the removed flags.
- [ ] The `HELP` string is rewritten to the new model (machines + projects +
      init + menu + `--shell`/`--mount`/`--keep`/`--rm`); it no longer documents
      `import`/`--fresh`/`--ephemeral` or the per-workdir home.
- [ ] After this task `cli.ts` no longer READS the old pure symbols
      (`buildRunPlan`/`stateAgentDir`/`resolveConfigSeed`/`pickProviderForLlm`/
      `resolveSourceModelsPath`) or the dead `AnonPiEnv` fields, but LEAVES them
      defined-and-exported in `anon-pi.ts` (their deletion is the follow-on
      `retire-legacy-pure-surface` task); the build stays green.
- [ ] `pnpm -r build` + `pnpm -r test` are GREEN in this task with NO dangling
      references (the reader rewrite lands; the pure symbols remain, still tested).
- [ ] Tests cover parsing + dispatch decisions at the pure seam (the RunPlan +
      run-vs-start inputs); the raw spawn/TTY I/O stays thin/untested. Mirror the
      existing `cli-*.test.ts` style.
- [ ] Every change produces a changeset; the `verify` gate passes (green
      `pnpm -r test`, no lingering failures from the retired CLI surface).
- [ ] Any host-dir creation in tests is isolated to a temp anon-pi home; the real
      `~/.anon-pi` is untouched.

## Blocked by

- `launch-run-plan-resolution` (the RunPlan it executes; adds the new pure surface
  this task rewrites `cli.ts` onto, then removes the old one).
- `run-vs-start-kept-container-decision` (the decision rule + query seam it wires
  to real netcage).
- `models-json-generation-from-llm` (adds the new generator ALONGSIDE the old
  `import`-source symbols; this task then removes those old symbols as the last
  step of the coordinated legacy-surface removal — so it must land after the
  generator exists and after the old symbols are no longer needed by new code).

## Prompt

> FIRST, check this task against current reality: confirm the RunPlan resolver and
> the run-vs-start decision (+ injected query seam) landed with the shapes this
> assumes. If they differ, adapt or route to needs-attention. Confirm the
> pure/impure split still holds (logic in `anon-pi.ts`, spawn/TUI in `cli.ts`).

anon-pi is a host-side launcher for the netcage jail. netcage forces egress
through a socks5h **proxy** (fail-closed) with ONE `--allow-direct` hole; this is
a HARD invariant — the CLI must never compose or spawn a netcage argv without the
proxy (the RunPlan guarantees it; do not strip/add egress).

Goal: land the thin launch path in `src/cli.ts`. Parse grammar A (bare positional
= PROJECT, `-m` = machine, `--shell [p]`, `--mount <parent> [p]`, `--keep`/`--rm`
default, `.` root token, trailing `<pi-args…>` forwarded to pi), enforce NAME vs
`--mount` exclusivity + reserved-name guard (pure validators), apply the no-TTY
discipline (bare menu + interactive pi need a TTY; headless `<project> <args>`
does not), create host dirs, resolve the RunPlan (pure), decide run-vs-start
against real netcage (`--keep` → `netcage start` a kept `netcage.managed`
container if present, else `netcage run`; `--rm` always fresh), and spawn with
inherited stdio propagating the exit code. Drop the old per-workdir launch,
`--ephemeral`/`--fresh`, and `import` dispatch.

You rewrite `cli.ts` onto the new pure surface (the RunPlan resolver + models.json
generator already exist alongside the old symbols) and own the BEHAVIOURAL
removals: rewrite the `HELP` string to the new model, and delete/rewrite
`cli-fresh.test.ts` + any CLI test asserting the removed
`--ephemeral`/`import`/per-workdir flags (they go red when the flow is gone). Do
NOT delete the old pure symbols
(`buildRunPlan`/`stateAgentDir`/`resolveConfigSeed`/`pickProviderForLlm`/
`resolveSourceModelsPath`) or the dead `AnonPiEnv`/`envFromProcess` fields from
`anon-pi.ts` here: leave them defined-and-exported (still compiling, their
`anon-pi.test.ts` blocks still green) once `cli.ts` stops reading them. Their
deletion is the follow-on `retire-legacy-pure-surface` task (`blockedBy` this
one), so each task stays single-purpose and the build is green at every step.

Keep the interactive menu TUI OUT of this task — wire bare launch to a menu
hook/stub the next task fills. Keep logic in the pure module; `cli.ts` stays thin
I/O. "Done" = `<project>`, `<project> <args>`, `--shell`, `-m`, `--mount`,
`--keep`/`--rm` all working end-to-end, tests green under `verify`, with a
changeset.

Note: this task is the BASE of the `src/cli.ts` chain. All the `cli-*` tasks edit
`src/cli.ts`, so they are chained one-after-another via `blockedBy` to avoid
parallel same-file conflicts: this task first, then
`cli-machine-verbs` → `cli-data-verbs-delete-home-project` → `cli-init-onboarding`
→ `cli-bare-launch-menu-tui`. Each builds on the version the previous one landed.

> RECORD non-obvious in-scope decisions (exit codes, exclusivity messages) as an
> ADR if they meet the gate, else a `## Decisions` note.

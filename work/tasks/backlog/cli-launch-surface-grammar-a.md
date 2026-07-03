---
title: CLI launch surface (grammar A) — parse, run-vs-start query, spawn netcage
slug: cli-launch-surface-grammar-a
prd: machines-and-projects-workspace
blockedBy: [launch-run-plan-resolution, run-vs-start-kept-container-decision]
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

**This task OWNS retiring the legacy CLI surface + its tests** (the `verify` gate
runs `pnpm -r test`, so nothing may stay red): rewrite the `HELP` string to the
new model (drop `import`/`--fresh`/`--ephemeral`/the per-workdir docs), delete
or rewrite `cli-fresh.test.ts` (the `--fresh` flow it exercises is gone), and
retire any CLI test locked to `--ephemeral`/`import`/the per-workdir launch. The
pure-module `buildRunPlan`/`stateAgentDir` retirement is owned by
`launch-run-plan-resolution` (already landed as a blocker); the `import`-source
pure logic by `models-json-generation-from-llm`.

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
      the launch path, AND their tests are retired: `cli-fresh.test.ts` is
      deleted/rewritten and no CLI test still asserts the removed flags.
- [ ] The `HELP` string is rewritten to the new model (machines + projects +
      init + menu + `--shell`/`--mount`/`--keep`/`--rm`); it no longer documents
      `import`/`--fresh`/`--ephemeral` or the per-workdir home.
- [ ] Tests cover parsing + dispatch decisions at the pure seam (the RunPlan +
      run-vs-start inputs); the raw spawn/TTY I/O stays thin/untested. Mirror the
      existing `cli-*.test.ts` style.
- [ ] Every change produces a changeset; the `verify` gate passes (green
      `pnpm -r test`, no lingering failures from the retired CLI surface).
- [ ] Any host-dir creation in tests is isolated to a temp anon-pi home; the real
      `~/.anon-pi` is untouched.

## Blocked by

- `launch-run-plan-resolution` (the RunPlan it executes).
- `run-vs-start-kept-container-decision` (the decision rule + query seam it wires
  to real netcage).

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

You OWN retiring the legacy CLI surface + its tests so the `verify` gate stays
green (it runs `pnpm -r test`): rewrite the `HELP` string to the new model, and
delete/rewrite `cli-fresh.test.ts` plus any CLI test asserting the removed
`--ephemeral`/`import`/per-workdir flags. (The pure-module `buildRunPlan`
retirement is owned by the `launch-run-plan-resolution` blocker; the
`import`-source pure logic by `models-json-generation-from-llm`.)

Keep the interactive menu TUI OUT of this task — wire bare launch to a menu
hook/stub the next task fills. Keep logic in the pure module; `cli.ts` stays thin
I/O. "Done" = `<project>`, `<project> <args>`, `--shell`, `-m`, `--mount`,
`--keep`/`--rm` all working end-to-end, tests green under `verify`, with a
changeset.

Note: this task and the other `cli-*` tasks all edit `src/cli.ts` and are
serialized via `blockedBy` to avoid conflicts — build on the landed version.

> RECORD non-obvious in-scope decisions (exit codes, exclusivity messages) as an
> ADR if they meet the gate, else a `## Decisions` note.

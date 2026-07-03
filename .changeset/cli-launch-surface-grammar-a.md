---
'anon-pi': minor
---

Rewrite the `src/cli.ts` launch path onto the machines + projects workspace
surface (grammar A). This is the breaking cutover from the 0.4.0 per-workdir
model.

- **Grammar A parsing** (new pure `parseLaunchArgs` in `src/anon-pi.ts`): a bare
  positional is a PROJECT; `-m <machine>` picks the machine; `--shell [<p>]` runs
  a jailed bash; `--mount <parent> [<p>]` roots at a HOST parent; `--keep`/`--rm`
  (throwaway default); the `.` root token; trailing `<pi-args…>` after the
  project are forwarded to pi verbatim. Enforces the reserved-name guard (via
  `validateName`) and rejects unknown options / a missing `-m`/`--mount`
  argument / a contradictory `--keep --rm`. `DEFAULT_MACHINE` = `default`.
- The CLI reads `config.json` / a machine's `machine.json`, resolves the machine
  (`-m` > `config.defaultMachine` > `default`) + its image (machine.json, else
  `ANON_PI_IMAGE`), the forced-egress inputs (proxy REQUIRED/fail-closed, llm),
  and the projects root, then resolves the `RunPlan` (pure `resolveRunPlan`) and
  spawns `netcage` with inherited stdio, propagating the exit code. The composed
  argv ALWAYS carries `--proxy` + the one `--allow-direct` (the RunPlan's
  guarantee; the CLI never strips or adds egress).
- **No-TTY discipline**: the bare menu and every interactive launch (interactive
  pi, a shell) require a TTY and error clearly without one; a headless
  `<project> <pi-args…>` run does not.
- **Run-vs-start**: under `--keep`, the CLI queries netcage for its kept
  `netcage.managed` containers (stamping/reading back an `anon-pi.key` label) and
  `netcage start`s a matching one (pure `resolveRunVsStart`), else `netcage run`
  without `--rm`; `--rm`/default is always a fresh `netcage run --rm`.
- Bare launch dispatches to a menu hook (a stub that points the user at direct
  launch; the interactive TUI lands in the follow-on task).

**Breaking / removed** (migration for 0.4.0 users): a bare positional is now a
PROJECT, not a host WORKDIR path; `--ephemeral`/`--fresh` and the `import`
subcommand are gone from the CLI (their replacements `--rm` / `init` /
`--delete-home` land in the surrounding tasks), and the per-workdir
`state/<slug>/` home model is not migrated. The `HELP` string is rewritten to
the new model. The old pure symbols (`buildRunPlan` / `stateAgentDir` /
`resolveConfigSeed` / `pickProviderForLlm` / `resolveSourceModelsPath`) and the
dead `AnonPiEnv` fields remain defined-and-exported (their deletion is the
follow-on `retire-legacy-pure-surface` task), so the build stays green.

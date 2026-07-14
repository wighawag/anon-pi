---
title: Launch RunPlan resolution for every mode (two-mount invariant, --rm/--keep, --mount, forwarded args, seed)
slug: launch-run-plan-resolution
spec: machines-and-projects-workspace
blockedBy: [machine-and-project-resolvers]
covers: [3, 4, 5, 6, 8, 11, 12, 13, 14, 16, 20]
---

## What to build

The core pure launch resolver: given the resolved env/config, a machine, and a
parsed launch intent, compute a **RunPlan** that composes the netcage argv for
every launch mode, preserving the forced-egress invariant on every path.

In the pure module (`src/anon-pi.ts`), resolve a RunPlan carrying:

- **Mode**: `menu` | `pi <project>` | `shell [project]` | `mount <parent>
  [project]`, and the `.` root token in each.
- **The TWO INVARIANT container mounts, always**: `<home>:/root` (the machine
  home) and `<projects-root>:/projects`. `--mount <parent>` adds EXACTLY the
  parent mount at a distinct path (`/work`) and roots cwd there; it never
  changes or removes the two invariant mounts. This sidesteps podman mount
  immutability (we never remount).
- **cwd**: `/projects/<project>` (pi) or `/projects` (`.`) or `/root` (shell at
  `~`); under `--mount`, `/work[/<project>]` or `/work`.
- **`--rm` vs keep**: throwaway (`--rm`) is the DEFAULT for all launches; the
  RunPlan omits `--rm` (leaves the container kept) only when `--keep` is set. The
  machine home persists regardless (it is a host mount).
- **Forwarded pi args**: `anon-pi <project> <pi-args…>` threads the extra args
  through to `pi` (headless/one-shot); `--shell` produces `bash` instead of `pi`.
- **Seed-if-fresh**: keep the marker-guarded (`.anon-pi-seed`) seed, but keyed
  per MACHINE home (not per workdir): promote image `/root` defaults + pi staging
  (`/opt/anon-pi-seed/agent`) + generated `models.json` into `$HOME` once. Reuse
  the existing `containerRunCmd` seed shape, re-pointed at the machine home.
- **Forced egress**: EVERY composed argv carries `--proxy <p>` and the single
  `--allow-direct <llm>` direct hole and nothing else that could leak. This is a
  hard invariant: no mode may compose a netcage argv without the proxy.

Keep it pure (no spawns, no fs writes). This is the heart of the rework;
`buildRunPlan`'s old per-workdir shape is replaced by this per-machine one.

Keep this task ADDITIVE to the pure module: ADD the new per-machine RunPlan
resolver + its new tests, and do the container-path CONSTANT rename
(`CONTAINER_WORKDIR`/related to `/projects`, plus the distinct `--mount`
`/work`) so the later `images-projects-path-rename` task only edits the
Dockerfiles + `trust.json`.

**Do NOT delete the old `buildRunPlan`/`stateAgentDir`/`resolveConfigSeed` here.**
`cli.ts` still imports and calls them, so removing them now would break
`pnpm -r build` (the gate) before the CLI is migrated. Leave them in place,
dead-but-present; the coordinated removal of the WHOLE legacy pure surface (those
symbols + `pickProviderForLlm`/`resolveSourceModelsPath` + the `HELP` string +
the dead `envFromProcess`/`AnonPiEnv` fields) and their `anon-pi.test.ts` describe
blocks is owned by `cli-launch-surface-grammar-a`, the one task that also removes
their last readers in `cli.ts`, so the build stays green. This task only ADDS.

## Acceptance criteria

- [ ] RunPlan resolves correctly for each mode: bare (menu marker), `<project>` →
      cwd `/projects/<project>`, `<project> <args>` → args forwarded to pi,
      `--shell [project]` → bash cwd, `-m <machine>`, `--mount <parent>
      [project]` → `/work[/project]` + the shared home, and `.` in each root.
- [ ] The two invariant mounts (`/root`, `/projects`) are ALWAYS present;
      `--mount` adds exactly one parent mount (`/work`) and nothing else changes.
- [ ] `--rm` is present by default and ABSENT under `--keep`; the machine home
      mount is present on every path.
- [ ] Seed-if-fresh is marker-guarded per machine home (promotes image defaults +
      pi staging + generated models.json once).
- [ ] EVERY composed netcage argv contains `--proxy <p>` and exactly one
      `--allow-direct <llm>`; a plan can never be produced without the proxy
      (fail-closed). A test asserts this on every mode.
- [ ] Tests cover the new behaviour (mirror existing pure-module test style),
      including the two-mount invariant, `--rm` on/off, forwarded args, and the
      forced-egress-on-every-mode assertion.
- [ ] This task is ADDITIVE to the pure module: it does NOT delete the old
      `buildRunPlan`/`stateAgentDir`/`resolveConfigSeed` (still called by `cli.ts`,
      so deleting them now would break `pnpm -r build`). Their coordinated removal
      is owned by `cli-launch-surface-grammar-a`. No existing describe block is
      rewritten here.
- [ ] The container-path constant is renamed in the pure module
      (`CONTAINER_WORKDIR`/related → `/projects`, distinct `--mount` `/work`), so
      the images task only touches Dockerfiles + `trust.json`.
- [ ] Every change produces a changeset; the `verify` gate passes (green
      `pnpm -r build` + `pnpm -r test` at THIS step, with the old symbols still
      present and unused by the new code).
- [ ] Tests ISOLATE any path derivation against a temp anon-pi home; no real
      `~/.anon-pi` is touched.

## Blocked by

- `machine-and-project-resolvers` (uses the machine/project resolvers, name
  validation, and `.` token; shares `src/anon-pi.ts`).

## Prompt

> FIRST, check this task against current reality: confirm the machine/project
> resolvers + `.` token landed, and that the pure module still owns argv
> composition (pure/impure split). If the resolver shapes differ from what this
> assumes, adapt or route to needs-attention.

anon-pi launches pi inside a netcage jail; netcage forces all egress through a
socks5h **proxy** (fail-closed) with ONE `--allow-direct` hole for a local model.
This is a HARD invariant you must never weaken: every netcage argv you compose
carries `--proxy` + exactly the one `--allow-direct`.

Goal: replace the old per-workdir `buildRunPlan` with the per-machine RunPlan
resolver in `src/anon-pi.ts`. Compose the netcage argv for every mode (menu / pi
`<project>` / shell `[project]` / `--mount <parent> [project]`, plus the `.` root
token). The design decision (from the prd): TWO invariant mounts ALWAYS
(`<home>:/root` and `<projects-root>:/projects`); `--mount` adds EXACTLY the
parent mount at `/work` and re-roots cwd there, changing nothing else (this
sidesteps podman mount immutability). Throwaway (`--rm`) is the DEFAULT; `--keep`
omits `--rm` to leave a kept container (its filesystem survives for the
apt-install/re-enter flow). Forward `<pi-args…>` through to `pi`; `--shell`
runs `bash`. Keep the marker-guarded seed-if-fresh but keyed per MACHINE home
(reuse the `containerRunCmd` seed shape, re-pointed at `/root`).

Keep this task ADDITIVE to the pure module: ADD the new RunPlan resolver + its
new tests, and do the container-path CONSTANT rename (`CONTAINER_WORKDIR`/related
→ `/projects`; distinct `--mount` `/work`) so the images task only edits the
Dockerfiles + `trust.json`. Do NOT delete the old
`buildRunPlan`/`stateAgentDir`/`resolveConfigSeed` (or any other legacy symbol):
`cli.ts` still calls them, so removing them now breaks `pnpm -r build` before the
CLI is migrated. Leave them dead-but-present. The coordinated removal of the whole
legacy pure surface (those symbols + `pickProviderForLlm`/`resolveSourceModelsPath`
+ the `HELP` string + the dead `envFromProcess`/`AnonPiEnv` fields) and their
`anon-pi.test.ts` describe blocks is owned by `cli-launch-surface-grammar-a`, the
one task that also removes their last `cli.ts` readers so the build stays green.

Keep it PURE (no spawn/fs). Test every mode at the RunPlan seam, and assert the
forced-egress argv on EVERY mode. "Done" = the new RunPlan resolver + the constant
rename + tests all green under `verify` (old symbols still present, unused), with a
changeset. The run-vs-start (kept-container) DECISION and the CLI spawn are
separate later tasks; this task only produces the plan.

> RECORD non-obvious in-scope decisions (cwd rules, the mount/`/work` path
> choice) as an ADR if they meet the gate, else a `## Decisions` note.

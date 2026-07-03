---
title: Launch RunPlan resolution for every mode (two-mount invariant, --rm/--keep, --mount, forwarded args, seed)
slug: launch-run-plan-resolution
prd: machines-and-projects-workspace
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

**This task OWNS retiring the legacy launch/state surface it replaces** (the
`verify` gate runs `pnpm -r test`, so the old tests must go GREEN, not linger
red): remove/replace the old `buildRunPlan` (per-workdir shape), `stateAgentDir`,
`resolveConfigSeed` (its last reader was the old `buildRunPlan` you are removing),
and the now-dead per-workdir container-path constants. Also perform the
container-path CONSTANT rename in the pure module (`CONTAINER_WORKDIR` + related →
`/projects`, plus the distinct `--mount` `/work`), so the later
`images-projects-path-rename` task only edits the Dockerfiles + `trust.json`.

**Test-file ownership (shared, split by describe-block).** `anon-pi.test.ts`
mixes launch/state cases and `import`-selection cases. THIS task owns
rewriting/retiring the launch/state describe blocks: `buildRunPlan required
inputs`, `buildRunPlan statefulness`, `buildRunPlan netcage argv`, `stateAgentDir
(persistent per-workdir home)`, and the `resolveConfigSeed`/`ANON_PI_CONFIG`
cases inside `path resolution` (its `resolveAnonPiHome` cases were already updated
by the `workspace-layout-and-config` blocker to the `~/.anon-pi/` default; you
remove only the now-dead `resolveConfigSeed` cases). LEAVE the
`import`-selection blocks (`pickProviderForLlm (import selection)`,
`resolveSourceModelsPath (import reads FROM)`) untouched — those are retired by
`models-json-generation-from-llm`, which is `blockedBy` THIS task and rebases
onto the file you leave. Do not delete the whole file; hand it over with only the
import blocks remaining. LEAVE `hostPortKey` and `pathSlug` as-is (they survive
unchanged), and LEAVE the `envFromProcess mapping` block alone: its dead-env-key
cleanup (`ANON_PI_CONFIG`/`ANON_PI_SOURCE_MODELS`/`ANON_PI_EPHEMERAL`) is owned by
`cli-launch-surface-grammar-a` (the last launch-path reader of those fields).
(The `HELP` string and the
`--fresh`/`--ephemeral`/`import` CLI surface are retired by
`cli-launch-surface-grammar-a`.)

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
- [ ] The legacy launch/state surface this replaces is RETIRED, not left dead:
      old `buildRunPlan` (per-workdir shape), `stateAgentDir`, `resolveConfigSeed`,
      and the dead per-workdir container-path constants are removed/replaced, and
      the `anon-pi.test.ts` `buildRunPlan`/`stateAgentDir` blocks + the
      `resolveConfigSeed`/`ANON_PI_CONFIG` cases in `path resolution` are rewritten
      or deleted (no red tests remain). `envFromProcess mapping` is left to
      `cli-launch-surface-grammar-a`.
- [ ] The `import`-selection describe blocks in `anon-pi.test.ts`
      (`pickProviderForLlm`, `resolveSourceModelsPath`) are LEFT INTACT for
      `models-json-generation-from-llm` (which is serialized after this task); the
      test file is handed over, not deleted wholesale.
- [ ] The container-path constant is renamed in the pure module
      (`CONTAINER_WORKDIR`/related → `/projects`, distinct `--mount` `/work`), so
      the images task only touches Dockerfiles + `trust.json`.
- [ ] Every change produces a changeset; the `verify` gate passes (green
      `pnpm -r test`, no lingering failures from the retired model).
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

You OWN retiring the launch/state surface this replaces (verify runs `pnpm -r
test`, so nothing may stay red): remove/replace the old `buildRunPlan`,
`stateAgentDir`, and `resolveConfigSeed`, plus the dead per-workdir
container-path constants, and rewrite or delete their `anon-pi.test.ts` describe
blocks (`buildRunPlan required inputs`, `buildRunPlan statefulness`, `buildRunPlan
netcage argv`, `stateAgentDir (persistent per-workdir home)`, and the
`resolveConfigSeed`/`ANON_PI_CONFIG` cases in `path resolution`). Do the
container-path CONSTANT rename here too (`CONTAINER_WORKDIR`/related →
`/projects`; distinct `--mount` `/work`), so the images task only edits the
Dockerfiles + `trust.json`. Do NOT touch: the `resolveAnonPiHome` cases in `path
resolution` (already updated by `workspace-layout-and-config`), the
`envFromProcess mapping` block (its dead-env-key cleanup is owned by
`cli-launch-surface-grammar-a`), the `import`-source logic
`pickProviderForLlm`/`resolveSourceModelsPath` (retired by
`models-json-generation-from-llm`, serialized after you), or the
`HELP`/`--fresh`/`--ephemeral`/`import` CLI surface (retired by
`cli-launch-surface-grammar-a`). Hand `anon-pi.test.ts` over with the import
blocks intact.

Keep it PURE (no spawn/fs). Test every mode at the RunPlan seam, and assert the
forced-egress argv on EVERY mode. "Done" = the RunPlan resolver + the retired
legacy surface + tests all green under `verify` (no lingering failures), with a
changeset. The run-vs-start (kept-container) DECISION and the CLI spawn are
separate later tasks; this task only produces the plan.

> RECORD non-obvious in-scope decisions (cwd rules, the mount/`/work` path
> choice) as an ADR if they meet the gate, else a `## Decisions` note.

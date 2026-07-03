---
'anon-pi': minor
---

Add the per-machine RunPlan resolver (`resolveRunPlan`) to `src/anon-pi.ts`: the
pure heart of the machines + projects rework. Given a resolved launch intent
(machine + mode + project token + the forced-egress inputs) it composes the
`netcage` argv for every launch mode, holding the forced-egress invariant on
every path.

- Modes (`LaunchMode`, `LaunchIntent`, `LaunchPlan`): `menu` (bare) yields an
  argv-less marker (the host-side TUI runs first); `pi <project>` cwds into
  `/projects/<project>` (or `/projects` for `.`) and forwards `<pi-args…>` to
  `pi`; `shell [project]` runs `bash` at `/root` (the machine home) or the
  project cwd; `--mount <parent>` re-roots into `/work[/<project>]`.
- The TWO invariant container mounts are ALWAYS present: `<home>:/root` and
  `<projects-root>:/projects`. `--mount` adds EXACTLY one parent mount at a
  distinct `/work` and changes nothing else (sidesteps podman mount
  immutability).
- `--rm` (throwaway) is the DEFAULT; `--keep` omits it to leave a kept
  container. The machine home mount survives on every path (it is a host mount).
- Marker-guarded seed-if-fresh keyed per MACHINE home (reuses the
  `containerRunCmd` seed shape re-pointed at `/root`), promoting the image's
  staged pi defaults + the generated `models.json` into a fresh home once.
- Forced egress is a HARD invariant: every composed argv carries `--proxy <p>`
  and exactly one `--allow-direct <llm>`; a plan can never be produced without
  the proxy or the direct hole (fail-closed).
- Adds the `CONTAINER_HOME_ROOT` (`/root`) constant for the machine home bind
  path, distinct from the `~` menu token.

Additive: the legacy per-workdir `buildRunPlan` (still called by `cli.ts`) is
left dead-but-present; its coordinated removal is owned by a later task.

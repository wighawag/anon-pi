---
title: Rename container work path /work → /projects in images + trust.json + seed
slug: images-projects-path-rename
spec: machines-and-projects-workspace
blockedBy: [launch-run-plan-resolution]
covers: [20]
---

## What to build

Align the shipped images with the new vocabulary: the container projects root is
`/projects` (from host `~/.anon-pi/projects/`), a rename from the current `/work`,
so the concept is "project" everywhere. (`--mount` keeps its own distinct `/work`
mount — do not collide the two.)

- Update `Dockerfile.pi` and `examples/Dockerfile.pi-webveil`: `WORKDIR` →
  `/projects` (the default projects-root cwd), and the pi `trust.json` staged in
  `/opt/anon-pi-seed/agent` to trust `/projects` (and `/work` for the `--mount`
  root) so pi does not prompt on the mounted project.
- Ensure `/root` has base-image `.bashrc` etc. to seed from, and that the seed
  path can create the projects area as needed (the machine home is the ONE mount
  at `/root`; the projects root is a separate mount at `/projects`).
- Confirm the webveil entrypoint composes with the seed-if-fresh run cmd and the
  `/projects/<name>` (or `/work` for `--mount`) cwd.

The container-path CONSTANT rename in the pure module (`CONTAINER_WORKDIR` →
`/projects`) is owned by the `launch-run-plan-resolution` blocker; this task only
edits the Dockerfiles + `trust.json` to AGREE with those settled paths.

## Acceptance criteria

- [ ] `Dockerfile.pi` and `examples/Dockerfile.pi-webveil` use `/projects` as the
      default cwd (`WORKDIR`), replacing `/work`.
- [ ] The staged `trust.json` trusts `/projects` (and `/work` for the `--mount`
      root) so pi does not prompt on the mounted project.
- [ ] The webveil entrypoint still composes with the seed-if-fresh run cmd and the
      `/projects/<name>` / `/work` cwd.
- [ ] Tests cover the image expectations that are unit-testable (mirror
      `dockerfile-webveil.test.ts` style): the trust path and WORKDIR
      assertions.
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] Any test writes stay in temp fixtures.

## Blocked by

- `launch-run-plan-resolution` (owns `/projects` as the mount target + cwd
  convention the images must agree with).

## Prompt

> FIRST, check this task against current reality: confirm the RunPlan task settled
> `/projects` as the projects-root mount target and `/work` as the distinct
> `--mount` root. If those container paths differ from what this assumes, adapt or
> route to needs-attention — the images must agree with the RunPlan's paths.

anon-pi renames the container project path from `/work` to `/projects` for
vocabulary consistency (the concept is "project" everywhere): the host projects
root (`~/.anon-pi/projects/`) mounts at `/projects`, which is pi's cwd. The
`--mount <parent>` host-parent root keeps its own DISTINCT `/work` mount, so the
two never collide.

Goal: update the shipped images to agree with the RunPlan's paths. In
`Dockerfile.pi` and `examples/Dockerfile.pi-webveil`, set `WORKDIR` to
`/projects` and stage a `trust.json` (in `/opt/anon-pi-seed/agent`) that trusts
`/projects` (and `/work` for the `--mount` root). Ensure `/root` has base `.bashrc`
etc. to seed from, and confirm the webveil entrypoint composes with the
seed-if-fresh run cmd and the new cwd.

Test at the same seam as the existing `dockerfile-webveil.test.ts` (assert the
trust path + WORKDIR). "Done" = images use `/projects`, trust the right paths,
tests green under `verify`, with a changeset.

> RECORD non-obvious in-scope decisions (which paths trust.json trusts) as a
> `## Decisions` note.

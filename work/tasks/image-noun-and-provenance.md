---
title: image noun — `image snapshot` (with provenance labels) + `image list`
slug: image-noun-and-provenance
prd: machines-and-projects-workspace
adr: 0003-image-as-first-class-concept
---

## What to build

Introduce the `image` noun and MOVE snapshot to it, baking provenance into the
image as podman labels (per ADR-0003 sections 1 + 2).

- **`anon-pi image snapshot <name> [-m <machine>] [--create-machine <m>]`**:
  commit the RUNNING container into `anon-pi/<name>:latest`. REUSE the existing
  container resolution (`resolveRunningContainer`, `-m` optional filter,
  auto-detect / picker). Bake provenance via `netcage commit -c 'LABEL ...'`:
  - `anon-pi.source-machine=<M>` (the committed container's machine, from its key)
  - `anon-pi.source-image=<ref>` (that machine's `machine.json.image` at snapshot)
  - `anon-pi.snapshot-at=<iso8601>`
  This REPLACES `machine snapshot` (move the verb from the `machine` noun to a new
  top-level `image` noun). `--create-machine <m>` runs the 0.15 home-copy +
  per-project session carry-over after the commit (reuses `copyHomeMinusSessions`
  + `carryOverSessions`).
- **`anon-pi image list`**: read-only; filter `netcage images` (podman-faithful
  JSON) to the `anon-pi/*` namespace, read each image's provenance labels
  (`podman inspect` / `netcage inspect --format`), and print `<name>  from
  machine <M>  <when>` (or `<name>  (no provenance)`). ZERO stored state.

## Pure vs impure

- PURE (`src/anon-pi.ts`): the `image <verb>` grammar parser
  (`parseImageArgs`: `snapshot <name> [-m <m>] [--create-machine <m>]` | `list`),
  the clean image-tag derivation (`snapshotImageTag(name)` -> `anon-pi/<name>:latest`),
  the provenance-label list builder (`snapshotProvenanceLabels({sourceMachine,
  sourceImage, at})` -> the `LABEL k=v` change instructions), and a parser for
  provenance labels read back (`parseImageProvenance(labels)` -> `{sourceMachine?,
  sourceImage?, snapshotAt?}`). All unit-tested.
- IMPURE (`src/cli.ts`): the `netcage commit -c ...` spawn, the `netcage images`
  + inspect reads for `image list`, and the `--create-machine` wiring.

## Acceptance criteria

- [ ] `image snapshot <name>` commits the running container to
      `anon-pi/<name>:latest` with the three provenance labels baked in.
- [ ] `image snapshot --create-machine <m>` also creates the machine, running the
      home-copy + per-project session carry-over (as 0.15 did).
- [ ] `image list` shows anon-pi images with their provenance; no stored state.
- [ ] `machine snapshot` is REMOVED (moved to `image snapshot`); MACHINE_HELP +
      top-level help + README updated; a changeset notes the breaking rename.
- [ ] The grammar parse, tag derivation, label build, and label parse are PURE +
      unit-tested. The commit/list wiring is covered with netcage stubbed off
      (hermetic, like the existing snapshot CLI test) so no test touches the real
      image store.
- [ ] A changeset (`minor`, but call out the `machine snapshot`->`image snapshot`
      breaking rename in the body).

## Notes / decisions

- Provenance is best-effort HISTORY (labels), never a live pointer; consumers
  tolerate a missing source machine.
- The clean tag is `anon-pi/<name>:latest` (overwrites a prior same-name tag;
  acceptable, the user chose the name).
- Depends on netcage `commit -c/--change` (present) + `images`/`inspect`
  (present, >= 0.10.0 for JSON).

---
title: image noun — `image snapshot` (with provenance labels) + `image list`
slug: image-noun-and-provenance
spec: machines-and-projects-workspace
adr: 0003-image-as-first-class-concept
---

## Prompt

> FIRST, check this task against current reality: confirm `machine snapshot`
> still lives on the `machine` noun in `src/cli.ts`, that `resolveRunningContainer`
> (the `forward`/`ports` running-container resolution) is available to reuse, and
> that `copyHomeMinusSessions` + `carryOverSessions` exist for the shared helper.
> If the surface has diverged, adapt or route to needs-attention.

Introduce the top-level `image` noun and MOVE snapshot to it (per ADR-0003 §1+2):
`anon-pi image snapshot <name> [-m <machine>] [--create-machine <m>]` commits the
RUNNING container into `anon-pi/<name>:latest`, baking provenance as podman labels
via `netcage commit -c 'LABEL ...'` (`anon-pi.source-machine`, `anon-pi.source-image`
read from the running container via inspect, `anon-pi.snapshot-at`). Add
`anon-pi image list` (read-only, zero stored state, surfaces orphaned/dangling
snapshots by ID). REMOVE `machine snapshot`. Factor the home-minus-sessions copy +
per-project session carry-over into ONE shared `carryOverHomeFromMachine` helper,
and make `machine create <m> --image <ref>` provenance-aware. Also fold in the
reserved-name fix (reserve the noun words; the menu must NOT crash on a
now-reserved pre-existing folder — it filters via the tolerant `isProjectName`).
Keep the grammar/tag/label logic PURE in `src/anon-pi.ts` and unit-tested; keep
the netcage commit/list wiring hermetic (netcage stubbed off, no real image store
touched). Land a `minor` changeset noting the `machine snapshot`→`image snapshot`
breaking rename. Full spec, decisions, and acceptance criteria are below.

> RECORD any non-obvious in-scope decision inline in `## Notes / decisions`, or an
> ADR if it meets the gate.

## What to build

Introduce the `image` noun and MOVE snapshot to it, baking provenance into the
image as podman labels (per ADR-0003 sections 1 + 2).

- **`anon-pi image snapshot <name> [-m <machine>] [--create-machine <m>]`**:
  commit the RUNNING container into `anon-pi/<name>:latest`. REUSE the existing
  container resolution (`resolveRunningContainer`, `-m` optional filter,
  auto-detect / picker). Bake provenance via `netcage commit -c 'LABEL ...'`:
  - `anon-pi.source-machine=<M>` (the committed container's machine, from its
    stamped key: `parseKeptKey(target.key).machine`, authoritative)
  - `anon-pi.source-image=<ref>` (what the snapshot is ACTUALLY built on: read
    from the RUNNING CONTAINER via inspect - `netcage inspect <ref> --format
    '{{.ImageName}}'` or equivalent - NOT `machine.json`, because `-i` makes the
    container's image diverge from the machine's pin. Fall back to
    `machine.json.image` if the inspect fails; OMIT the label if neither is known
    - a missing label beats a wrong one, provenance is best-effort history)
  - `anon-pi.snapshot-at=<iso8601>`
  This REPLACES `machine snapshot` (move the verb from the `machine` noun to a new
  top-level `image` noun). `--create-machine <m>` runs the 0.15 home-copy +
  per-project session carry-over after the commit.
- **Factor the copy into ONE shared helper** `carryOverHomeFromMachine(env,
  sourceMachine, destMachine)`: the home-minus-sessions copy
  (`copyHomeMinusSessions`) + the interactive per-project session picker
  (`carryOverSessions`). Both callers below use it; they differ ONLY in how they
  learn `sourceMachine`. Honors the no-TTY "copy nothing" rule already in
  `carryOverSessions`, so a scripted create stays non-blocking.
  - `image snapshot --create-machine <m>`: has the source machine directly (it
    just committed that container) -> call the helper with it.
- **`machine create <m> --image <ref>` becomes PROVENANCE-AWARE** (fold into this
  task or its own small follow-up): after creating + pinning, inspect `<ref>` for
  `anon-pi.source-machine`. If present AND that machine's home exists on disk,
  call `carryOverHomeFromMachine` (offer the copy). If absent / home gone: plain
  fresh create (today's behavior) with a quiet note. Guard no-TTY (copy nothing).
- **`anon-pi image list`**: read-only; list anon-pi images with their provenance.
  Include an image if it is `anon-pi/*`-tagged OR (even when DANGLING/untagged) it
  carries an `anon-pi.source-machine` label - so an ORPHANED snapshot (its
  `:latest` tag was overwritten by a re-snapshot, decision below) is still shown,
  by its ID. Print `<name-or-<none>>  from machine <M>  <when>  id:<short>`.
  Provenance labels are read via `podman inspect` / `netcage inspect --format`.
  ZERO stored state.

## Same-name re-snapshot: overwrite `:latest`, orphans stay referenceable

- `image snapshot <name>` writes `anon-pi/<name>:latest`; a same-name re-snapshot
  OVERWRITES the tag (that is what `:latest` means). The previous image is not
  deleted - it becomes DANGLING (untagged) but keeps its provenance label, so
  `image list` still surfaces it (by ID) and `-i <id>` still launches it. To
  PRESERVE a specific snapshot under a friendly name, snapshot it under a
  DIFFERENT name (the explicit "keep this one" gesture); there is NO retag verb
  (podman's own `podman tag` covers the rare manual case).
- FOLLOW-UP (not this task): a thin `image rm`/`image prune` for reclaiming
  orphaned ~3GB images (podman's `image prune` is the boundary; defer).

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

## Reserved-name fix (fold in here)

- Add the subcommand NOUN words to `RESERVED_NAMES`: `image` (new) AND the
  pre-existing dispatch words `machine`, `init`, `forward`, `ports`. Today these
  are reserved only STRUCTURALLY (dispatched before the launch parser), so a
  project folder named e.g. `machine` can exist but is UNREACHABLE by bare name
  (a latent wart). Reserving them makes `validateName` refuse such a name up
  front with a clear "reserved name" error, closing the trap. `pi` is already
  reserved. Update RESERVED_NAMES + its tests.
- Wire `image` as a subcommand: add to `OWN_HELP_SUBCOMMANDS` and an
  `args[0] === 'image'` dispatch (before the launch grammar), mirroring `machine`.
- The reservation is GLOBAL (validateName is the one validator), so a snapshot /
  machine / project named after a reserved word is refused everywhere (consistent,
  not a loss). VERIFIED-safe for pre-existing folders: the menu filters project
  folders through the tolerant `isProjectName` (try/catch), so a folder that is
  NOW reserved is silently skipped from the menu, NOT a crash.
- [ ] AC: a pre-existing project folder whose name is now reserved does not crash
      the menu / `image list` (it is skipped), and creating a new such name is
      refused with a clear "reserved name" error.

## Notes / decisions

- Provenance is best-effort HISTORY (labels), never a live pointer; consumers
  tolerate a missing source machine.
- The clean tag is `anon-pi/<name>:latest` (overwrites a prior same-name tag;
  acceptable, the user chose the name).
- Depends on netcage `commit -c/--change` (present) + `images`/`inspect`
  (present, >= 0.10.0 for JSON).
- VERIFIED empirically (2026-07-05): `podman commit --change 'LABEL k=v'` (what
  `netcage commit -c` forwards to) round-trips label VALUES containing `/` and
  `:` intact and un-truncated, with NO special quoting (each `-c` is one argv
  element). Tested all three labels incl. `source-image=anon-pi/webscan:latest`
  and an ISO `snapshot-at`; all read back correct via `inspect --format
  '{{json .Config.Labels}}'`. So `image list`'s label read + the commit label
  bake are both sound. NOTE: `netcage commit` accepts ONLY a netcage-managed
  container name (refuses an arbitrary podman container), which is exactly the
  path `image snapshot` uses (resolveRunningContainer -> a managed tool container).

# Image as a first-class concept (decoupled from the machine home)

## Context

ADR-0001 welded IMAGE and HOME together in a machine: `machine.json.image` is the
image, and the machine's home was built for it (which is why `set-image` WARNS
that the home was built for the old image). There was no way to keep a machine's
home (its identity, config, conversations) while running it against a DIFFERENT
image, and no way to produce just an image (the initial `machine snapshot`,
0.13-0.15, always produced a whole new machine + copied home + session prompts).

Two needs drove this ADR:

1. Run a machine's HOME against a chosen IMAGE ad-hoc (e.g. try a snapshot image,
   or a heavier/lighter base, keeping the same conversations + config).
2. Snapshot a running container into an IMAGE ALONE, and separately (and possibly
   after the fact) decide to build a machine from it.

## Decision

Split IMAGE and HOME into two composable concepts, with podman as the single
image registry (no anon-pi-side image store).

### 1. `image` becomes a noun (a thin surface over podman/netcage)

- `anon-pi image snapshot <name> [-m <machine>]`: commit a RUNNING container into
  a clean image tag `anon-pi/<name>:latest`. Container resolution REUSES the
  snapshot machinery (`-m` is the same OPTIONAL filter; auto-detect one, picker
  for many). This REPLACES `machine snapshot` (the verb moves from the `machine`
  noun to the `image` noun; a days-old breaking rename).
- `anon-pi image list`: read-only; filter `netcage images` to the `anon-pi/*`
  namespace and show each with its provenance (below). ZERO stored state.

### 2. Provenance lives IN THE IMAGE (labels), not in an anon-pi registry

`image snapshot` bakes provenance as podman LABELS via `netcage commit -c 'LABEL
...'`:

- `anon-pi.source-machine=<M>` — the machine whose running container was committed.
- `anon-pi.source-image=<ref>` — that machine's image at snapshot time.
- `anon-pi.snapshot-at=<iso8601>` — when.

The image IS its own registry: `image list` reads the labels back; if podman
prunes an image, its provenance vanishes with it (correct: no dangling records).
Provenance is best-effort HISTORY, never a live pointer (the named source machine
may be gone; consumers must tolerate that).

### 3. `-i <ref>` / `--image <ref>`: an EPHEMERAL, per-launch image override

- Slots into the launch grammar beside `-m`, `--shell`, `--mount` (there is no
  `--keep`: retired by ADR-0004; every launch is throwaway).
- Highest priority in the image-resolution chain:
  `-i` > `machine.json.image` > `ANON_PI_IMAGE` > error.
- Composes with `-m`: `-m` picks the HOME, `-i` picks the IMAGE.
- Does NOT mutate `machine.json` (unlike `set-image`, which is persistent).
- NO mismatch warning. Rationale: `-i` is explicit and ephemeral (the user holds
  the intent now), so a warning carries no information they lack; and provenance
  identifies the source MACHINE, not COMPATIBILITY, so a naive "label != current
  machine" check false-positives on legitimate descendants. We KEEP the label
  (it enables `image list` + the auto-copy below) but do NOT warn on `-i` now. A
  lineage-aware warning can be added later if a real need appears.

### 4. `--keep`/`--rm` are RETIRED (superseded by snapshot + `-i`) - see ADR-0004

The initial plan had the image join `keptContainerKey` (so two `--keep` launches
differing only in image would not cross-resume). During the ADR-0003 grill we
concluded that `snapshot` + `-i` REPLACE the `--keep` use case entirely ("apt
install, quit, re-enter" = snapshot to an image, relaunch via `-i` / a
machine pinned to it), and that `--keep`'s mutable-inferred-identity is the very
source of the resume-vs-fresh ambiguity. So `--keep`/`--rm` and the whole
kept-container run-vs-start inference are RETIRED (ADR-0004); every launch is
throwaway. This makes the image/kept-key question MOOT: there are no kept
containers to key. The durable-environment need is met by a machine pinned to a
snapshot image (a real name, no inference). A future explicit `container` noun
(work/notes/ideas/container-create-flow.md) may reintroduce durable named boxes
WITHOUT the inference.

### 5. Machine creation is provenance-aware; `--create-machine` is a convenience

- `anon-pi machine create <name> --image <ref>` (existing verb): if `<ref>`
  carries `anon-pi.source-machine=<M>` AND that machine's home still exists,
  OFFER the home-copy (minus sessions) + per-project session carry-over (the
  exact 0.15 prompts), after the fact. No provenance / home gone => plain fresh
  create, as today.
- `anon-pi image snapshot <name> --create-machine <m>`: convenience shortcut that
  snapshots THEN creates a NEW machine (running the same home-copy + session
  carry-over). Kept because it is the common one-step path; it is redundant with
  `image snapshot` + provenance-aware `machine create`, but nicer.
- `anon-pi image snapshot <name> --update-machine <m>`: the mirror shortcut that
  snapshots THEN RE-PINS an EXISTING machine to the fresh snapshot (redundant
  with `image snapshot` + `machine set-image`, but nicer). It does NOT copy the
  home; when `<m>` IS the snapshot's own source machine the home already matches
  the new image, so the `set-image` compatibility warning is SUPPRESSED (re-pinning
  a DIFFERENT machine still warns). `--create-machine` and `--update-machine` are
  mutually exclusive, and each fail-fast on the wrong existence state
  (`--create-machine` refuses an existing name; `--update-machine` a missing one),
  so a mistyped name never silently mutates a durable machine.

## Consequences

- Concept count stays honest: MACHINE = home (+ a default image); IMAGE = a
  podman tag (optionally `anon-pi/*`-namespaced, carrying provenance labels).
  `-m` picks the home, `-i` picks the image, they compose.
- Breaking: `machine snapshot` becomes `image snapshot` (days-old verb; note it
  in the changeset). The 0.15 home-copy + session carry-over move to the
  `--create-machine` path and to provenance-aware `machine create`.
- ADR-0002 amended: the kept-container key now includes the resolved image.
- No new persisted anon-pi state: podman/netcage remain the single image source
  of truth; provenance is baked into image labels.
- Accepted footgun: `-i` an image incompatible with the home (extensions built
  for another base) may break pi's extensions. This is the same hazard
  `set-image` warns about, accepted silently here because `-i` is explicit +
  ephemeral. The fix is obvious (use a compatible image).

## Out of scope (for now)

- A lineage-aware `-i` compatibility warning (needs machine lineage, not just
  image provenance).
- An anon-pi-side image registry / rename / prune verbs (podman owns images;
  `image list` is read-only).

# Retire `--keep`/`--rm`: throwaway always, persistence via snapshot images

## Context

ADR-0001 made the container throwaway by default (`--rm`) and reserved `--keep`
for the exploratory "apt install, quit, re-enter" flow, backed by the
run-vs-start inference of ADR-0002 (a kept container is matched by an INFERRED
identity key `(machine, projectsRoot, mountParent, cwd)`).

Two problems, surfaced while designing the `image` concept (ADR-0003):

1. **`--keep` fuses two intents into one flag and cannot tell them apart.** A
   `--keep` launch means BOTH "create a fresh kept container" AND "re-enter the
   existing one"; identity is INFERRED, so it cannot distinguish "resume my box"
   from "give me a new one" (especially once `-i` makes the image variable: does
   `--keep -i anon-pi/x:latest` after re-tagging resume the old box or build a
   new one? Neither answer is unambiguous under an inferred key).

2. **`snapshot` (ADR-0003) already covers `--keep`'s use case, better.** "apt
   install, quit, re-enter" = `image snapshot <name>` (freeze the filesystem into
   a named, immutable image) then relaunch via `-i <name>` or a machine pinned to
   it. This is explicit, named, and unambiguous; the only thing `--keep` uniquely
   preserved is UNCOMMITTED in-container scratch (shell history, /tmp), which is
   precisely the state a user should not depend on surviving. pi's real state
   (config, conversations) is in the HOST home and persists regardless.

## Decision

Retire `--keep` and `--rm`. **Every launch is throwaway** (the container is
always `--rm`). Durable state is EXPLICIT and image-based:

- do system work in a session -> `anon-pi image snapshot <name>` -> relaunch via
  `-i <name>`, or `anon-pi machine create <m> --image <name>` for a durable
  named environment (a machine pinned to a snapshot image: a real name, no
  inference).

Remove the run-vs-start inference (ADR-0002 is thereby SUPERSEDED for the
kept-container purpose): `resolveRunVsStart`, `keptContainerKey` as a
kept-matching key, `queryKeptContainers`, and the `--keep`/`--rm` grammar.

### KEEP (do NOT remove): the identity label for `forward`/`ports`

The `anon-pi.key` label is stamped on EVERY launch (not just `--keep`) and
`forward`/`ports` depend on it to find a RUNNING container and read its project
(`parseKeptKey` -> `keyProject`). This is INDEPENDENT of kept-container matching:
it identifies a live container for host-port forwarding, which still exists in a
throwaway world (a running `--rm` container is forwardable until it exits). So
`withKeyLabel`, the label stamp, `parseKeptKey`, and `keyProject` STAY. Only the
kept-container run-vs-start decision + the `--keep`/`--rm` flags go. The stamped
key may be simplified (it no longer needs to be a match key), but it still must
encode enough for `keyProject` (the cwd/project) and the machine filter.

## Consequences

- Simpler model: two nouns (machine, image), no murky kept-container, no
  `--keep`/`--rm` split, no run-vs-start inference, no string-vs-image-id keying
  dilemma. The whole ADR-0003 kept-key amendment becomes moot.
- Breaking: `--keep` and `--rm` are removed from the launch grammar (they were
  core since the 0.5 rework). A launch that passes them errors with guidance
  pointing at `image snapshot` + `-i` / `machine create --image`.
- ADR-0002 is superseded for kept-container matching. Its cwd/identity reasoning
  still informs the retained `anon-pi.key` label (project + machine), so the ADR
  is amended, not deleted.
- Lost capability: a single mutable pet-container that accretes uncommitted
  scratch across sessions. Deliberately dropped (it is the source of the identity
  ambiguity). A FUTURE explicit `container` noun
  (work/notes/ideas/container-create-flow.md) can reintroduce durable NAMED boxes
  WITHOUT inference, if the workflow proves central.
  **SUPERSEDED by ADR-0005** (2026-07-05): that future `container` noun is now
  built. Durable mutable boxes are back as an explicit, opt-in, NAMED noun
  (`container create`/`enter`/`list`/`rm`), with no create-vs-enter inference and
  the forced-egress + identity-label invariants intact. The bare launch stays
  throwaway; this note's "deliberately dropped" no longer holds for the opt-in
  path. See `docs/adr/0005-container-noun-durable-boxes.md`.

## Out of scope

- The `container` noun (captured as an idea; not built now).
- A kept-container prune/list verb (moot once there are no kept containers).

## Rollout (ADR-0003 + 0004 together)

Implemented in three ordered tasks but shipped as ONE release (0.16.0, a rolling
MINOR - not 1.0.0; the model is still being reshaped, so 1.0.0 stays a deliberate
"model is stable" statement for later). Sole user, so a single combined release is
fine. Order:

1. `retire-keep-throwaway-always` - remove `--keep`/`--rm` + run-vs-start
   inference; keep the forward/ports identity label. Foundational simplification.
2. `image-noun-and-provenance` - the `image` noun (`snapshot` with provenance
   labels, `list` incl. orphans), reserved noun words, the shared
   `carryOverHomeFromMachine` helper, provenance-aware `machine create --image`.
3. `launch-image-override` - the ephemeral `-i` flag (fresh-home refusal; store
   boundary guidance; no pre-check/auto-pull).

One changeset for the combined 0.16.0 (call out the BREAKING `--keep`/`--rm`
removal and the `machine snapshot` -> `image snapshot` rename).

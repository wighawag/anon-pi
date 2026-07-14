---
title: Retire `--keep`/`--rm` - throwaway always; keep the forward/ports identity label
slug: retire-keep-throwaway-always
spec: machines-and-projects-workspace
adr: 0004-retire-keep-throwaway-always
---

## Prompt

> FIRST, check this task against current reality: confirm `src/anon-pi.ts` +
> `src/cli.ts` still carry the `--keep`/`--rm` grammar, `resolveRunVsStart`,
> `KeptContainer`, and the `queryKeptContainers` run-vs-start branch, and that
> the `anon-pi.key` identity label (`withKeyLabel`/`parseKeptKey`/`keyProject`)
> is still in place. If the surface has already diverged, adapt or route to
> needs-attention.

Retire `--keep`/`--rm` and the kept-container run-vs-start inference: every
launch is throwaway (`--rm` always). CRITICALLY, **KEEP** the `anon-pi.key`
identity label and its decode path (`parseKeptKey`/`keyProject`) — `forward`,
`ports`, and `image snapshot` all resolve a RUNNING container via that label, so
only the kept-container MATCHING goes, never the label itself. Passing `--keep`
or `--rm` must now ERROR with guidance toward `image snapshot <name>` + `-i` /
`machine create --image`. Work the full spec, decisions, and acceptance
criteria in the sections below; keep dispatch thin (logic in the pure module),
land tests + README/help updates + a changeset (call out the BREAKING removal).

> RECORD any non-obvious in-scope decision (e.g. how the retained key is
> simplified) inline in `## Notes / decisions`, or an ADR if it meets the gate.

## What to build

Remove `--keep`/`--rm` and the kept-container run-vs-start inference; every launch
is throwaway. KEEP the `anon-pi.key` identity label (forward/ports need it).

Remove:
- The `--keep`/`--rm` grammar in `parseLaunchArgs` (+ the contradictory-flags
  error) and the `keep` field on ParsedLaunch / LaunchIntent.
- `resolveRunVsStart`, `KeptContainer`, and the CLI `queryKeptContainers` +
  run-vs-start branch in `runLaunch` (always a fresh `run`).
- The `--rm` conditional in `resolveRunPlan`: always push `--rm`.

KEEP (adjust, do NOT delete):
- `withKeyLabel` + the `anon-pi.key` stamp on every launch, `parseKeptKey`,
  `keyProject`, `queryRunningContainers`, `resolveManagedMatches`,
  `resolveForwardTarget`/`resolveRunningContainer` - forward/ports/image-snapshot
  all resolve a RUNNING container via this label. The stamped key still needs the
  machine + cwd (for `keyProject` + the machine filter); it no longer needs to be
  a kept-MATCH key, so it may be simplified but must stay decodable.

Errors:
- `anon-pi <project> --keep` (or `--rm`) => a clear error pointing at
  `anon-pi image snapshot <name>` + `-i <name>` / `anon-pi machine create
  <m> --image <name>` for durable state.

## Acceptance criteria

- [ ] `--keep` and `--rm` are removed; passing either errors with guidance toward
      snapshot + `-i` / `machine create --image`.
- [ ] Every launch runs `--rm` (throwaway); the run-vs-start inference is gone
      (no `queryKeptContainers`, no `resolveRunVsStart`).
- [ ] `forward` and `ports` still work: the `anon-pi.key` label is still stamped
      on every launch and read back (`parseKeptKey`/`keyProject`); a running
      container is still findable + forwardable until it exits.
- [ ] `image snapshot` still resolves its running container (it uses the same
      running-container resolution, unaffected).
- [ ] Tests updated: drop the `--keep`/run-vs-start suites; keep + adjust the
      forward/ports + key-label tests; add a test that `--keep`/`--rm` now error.
- [ ] README + help updated: remove the kept-vs-throwaway section, replace with
      "throwaway always; persist with `image snapshot` + `-i` / a pinned machine".
      The 0.4.0 migration note already flags `--ephemeral`->`--rm`; add that
      `--keep`/`--rm` are now gone entirely.
- [ ] A changeset (call out the BREAKING removal of `--keep`/`--rm`).

## Notes / decisions

- Ordering: land this BEFORE `launch-image-override` so `-i` arrives in a world
  with no kept containers (no kept-key to touch). It can land alongside/after
  `image-noun-and-provenance` (snapshot is the replacement the error points to).
- ADR-0002 is superseded for kept matching but its cwd/project reasoning still
  underpins the retained label; update its references, do not delete the ADR.

---
title: `-i <image>` launch override (ephemeral per-launch image)
slug: launch-image-override
prd: machines-and-projects-workspace
adr: 0003-image-as-first-class-concept
blockedBy: [image-noun-and-provenance, retire-keep-throwaway-always]
---

## What to build

The ephemeral per-launch image override (ADR-0003 section 3). NOTE: the
kept-container-key amendment is DROPPED - `--keep` is retired (ADR-0004), so
there are no kept containers to key. This task is now just the `-i` flag.

- **`-i <ref>` / `--image <ref>` on the launch grammar** (beside `-m`, `--shell`,
  `--mount`). Highest-priority image source:
  `-i` > `machine.json.image` > `ANON_PI_IMAGE` > error. Composes with `-m`
  (`-m` picks the HOME, `-i` picks the IMAGE). Does NOT mutate `machine.json`.
  NO mismatch warning (per ADR-0003: explicit + ephemeral).

## Pure vs impure

- PURE (`src/anon-pi.ts`): parse `-i/--image` in `parseLaunchArgs` into the
  ParsedLaunch; thread the resolved image into `keptContainerKey` +
  `parseKeptKey` (new `image=` field); keep `resolveRunVsStart` reading the key.
- IMPURE (`src/cli.ts`): resolve `-i` into `machine.image` in `runLaunch` (the
  `-i` value overrides `machineConf.image ?? env.image`).

## Acceptance criteria

- [ ] `anon-pi <project> -i <ref>` launches that project's machine home against
      `<ref>` (image resolution: `-i` wins over machine.json + env).
- [ ] `-i` composes with `-m`, `--shell`, `--mount`; `machine.json` is unchanged
      after an `-i` launch.
- [ ] No warning is printed for an `-i` that differs from the machine's image.
- [ ] Pure tests: `-i` parse into ParsedLaunch; the image-resolution precedence
      (`-i` > machine.json > env) is covered.
- [ ] A changeset (`minor`).

## `-i` on a FRESH (unseeded) home: refuse with guidance

- `-i` is STRICTLY ephemeral: it NEVER mutates `machine.json` (one simple rule).
- On a FRESH home (no seed marker), the machine's image/home baseline is not yet
  established. Seeding from the ephemeral `-i` image would poison the home
  (wrong-image seed); silently skipping the seed would run pi UNCONFIGURED. So
  instead REFUSE with guidance: "machine <m> has no home yet; establish its image
  with `anon-pi machine create <m> --image <ref>` (or launch once normally to
  seed), then use `-i` to override per-launch." This keeps `-i` purely ephemeral
  and channels "make this the machine's image" to the explicit machine verb.
- On an ALREADY-SEEDED home, `-i` just runs the override image against the
  existing home (no seed runs; the marker is present). The runtime
  extension-compat risk is accepted silently (ADR-0003: no warning).
- Implementation hook: the existing `homeFresh(machineHome)` (CLI, reads the
  `.pi/agent/<SEED_MARKER>` marker) already gives the signal in `runLaunch`
  exactly where `-i` is resolved - `if (iSet && homeFresh(home)) errorGuidance()`.
  No new machinery.

## Image store boundary (guidance only; no pre-check, no auto-pull)

- `-i` resolves in NETCAGE'S private graphroot store (`netcage run --root
  <graphroot>`), NOT the operator's default podman store. A snapshot
  (`image snapshot`) and `init`-built images live there and always resolve; a
  plain `podman pull`ed image in the DEFAULT store is INVISIBLE to netcage.
- anon-pi does NOT pre-check the ref's existence and does NOT auto-pull: it
  passes the ref to the RunPlan; netcage/podman finds it, attempts a pull, or
  fails, and netcage's own error surfaces via inherited stdio. Auto-pull is
  explicitly ruled out (an anonymity tool must not silently fetch a remote image;
  a pull's egress path is the user's explicit decision).
- `-i`'s help/docs state the store boundary so a "not found" is understood (fix:
  `image snapshot` it, or build it into netcage's store), not mystifying.

## Notes / decisions

- `-i` accepts any podman ref (a raw ref or an `anon-pi/<name>` snapshot tag).
- Blocked by retire-keep-throwaway-always so `-i` lands in a world with no kept
  containers (no kept-key to touch).

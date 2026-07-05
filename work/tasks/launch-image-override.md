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

## Notes / decisions

- `-i` accepts any podman ref (a raw ref or an `anon-pi/<name>` snapshot tag).
- Blocked by retire-keep-throwaway-always so `-i` lands in a world with no kept
  containers (no kept-key to touch).

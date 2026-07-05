---
title: `-i <image>` launch override + image in the kept-container key
slug: launch-image-override-and-kept-key
prd: machines-and-projects-workspace
adr: 0003-image-as-first-class-concept
blockedBy: [image-noun-and-provenance]
---

## What to build

The ephemeral per-launch image override and the kept-key amendment (ADR-0003
sections 3 + 4).

- **`-i <ref>` / `--image <ref>` on the launch grammar** (beside `-m`, `--shell`,
  `--mount`, `--keep`/`--rm`). Highest-priority image source:
  `-i` > `machine.json.image` > `ANON_PI_IMAGE` > error. Composes with `-m`
  (`-m` picks the HOME, `-i` picks the IMAGE). Does NOT mutate `machine.json`.
  NO mismatch warning (per ADR-0003: explicit + ephemeral).
- **Image joins `keptContainerKey`** (amends ADR-0002): add the resolved image as
  a keyed field, so two `--keep` launches of the same (machine, projectsRoot,
  mountParent, cwd) but DIFFERENT images are distinct kept containers and never
  cross-resume. Update `parseKeptKey` + any consumers (`keyProject` is
  unaffected; the picker label MAY show the image).

## Pure vs impure

- PURE (`src/anon-pi.ts`): parse `-i/--image` in `parseLaunchArgs` into the
  ParsedLaunch; thread the resolved image into `keptContainerKey` +
  `parseKeptKey` (new `image=` field); keep `resolveRunVsStart` reading the key.
- IMPURE (`src/cli.ts`): resolve `-i` into `machine.image` in `runLaunch` (the
  `-i` value overrides `machineConf.image ?? env.image`).

## Acceptance criteria

- [ ] `anon-pi <project> -i <ref>` launches that project's machine home against
      `<ref>` (image resolution: `-i` wins over machine.json + env).
- [ ] `-i` composes with `-m`, `--shell`, `--mount`, `--keep`; `machine.json` is
      unchanged after an `-i` launch.
- [ ] No warning is printed for an `-i` that differs from the machine's image.
- [ ] `keptContainerKey` includes the resolved image: `--keep -i A` then
      `--keep -i B` (same machine + cwd) are DIFFERENT kept containers (fresh run,
      not a cross-resume); same `-i` re-entry resumes the same one.
- [ ] `parseKeptKey` round-trips the new `image=` field; existing `forward`/`ports`
      filtering still works (image is additive, not a filter there).
- [ ] Pure tests: `-i` parse; the kept-key includes image + round-trips; the
      run-vs-start decision distinguishes images. Update ADR-0002-referencing
      tests/comments to note the image is now IN the key.
- [ ] A changeset (`minor`).

## Notes / decisions

- `-i` accepts any podman ref (a raw ref or an `anon-pi/<name>` snapshot tag).
- The kept-key encoding is opaque (ADR-0002); adding a field is safe as long as
  producers + `parseKeptKey` agree. Old kept containers (pre-image-key) parse
  with an empty image field; that is acceptable (they simply will not match a new
  `-i` launch, which is correct).

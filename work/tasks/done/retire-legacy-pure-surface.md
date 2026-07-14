---
title: Retire the orphaned legacy pure surface (buildRunPlan/import symbols + dead env fields)
slug: retire-legacy-pure-surface
spec: machines-and-projects-workspace
blockedBy: [cli-launch-surface-grammar-a]
covers: []
---

## What to build

A focused cleanup: delete the now-orphaned legacy pure-module symbols and their
tests, once their last reader (`cli.ts`) is gone. This is the final step of the
0.4.0-model retirement; it adds no behaviour, only removes dead code so the pure
module reflects the new machines + projects model.

By the time this task runs, `cli-launch-surface-grammar-a` has rewritten `cli.ts`
onto the new RunPlan resolver + models.json generator, so nothing in `src/` reads
the old symbols anymore (they were left defined-and-exported precisely so the CLI
rewrite could land green). Remove, in one green step:

- the dead pure functions in `src/anon-pi.ts`: `buildRunPlan` (old per-workdir
  shape), `stateAgentDir`, `resolveConfigSeed`, `pickProviderForLlm`,
  `resolveSourceModelsPath`;
- the dead `AnonPiEnv` fields + their `envFromProcess` mappings:
  `ephemeral`/`configSeed`/`sourceModels` and the
  `ANON_PI_EPHEMERAL`/`ANON_PI_CONFIG`/`ANON_PI_SOURCE_MODELS` env keys;
- the corresponding `anon-pi.test.ts` describe blocks: `buildRunPlan required
  inputs`, `buildRunPlan statefulness`, `buildRunPlan netcage argv`, `stateAgentDir
  (persistent per-workdir home)`, `pickProviderForLlm (import selection)`,
  `resolveSourceModelsPath (import reads FROM)`, the `resolveConfigSeed`/
  `ANON_PI_CONFIG` cases inside `path resolution`, and the `envFromProcess
  mapping` block.

KEEP the surviving surface: the new layout/config resolvers, the new RunPlan
resolver, the models.json generator, `resolveAnonPiHome` (its `path resolution`
cases already updated to `~/.anon-pi/`), `hostPortKey`, and `pathSlug`. End with
NO dead exports and NO dangling references.

## Acceptance criteria

- [ ] The dead pure functions are deleted from `src/anon-pi.ts`: `buildRunPlan`
      (old shape), `stateAgentDir`, `resolveConfigSeed`, `pickProviderForLlm`,
      `resolveSourceModelsPath` — with no remaining references anywhere in `src/`.
- [ ] The dead `AnonPiEnv` fields (`ephemeral`/`configSeed`/`sourceModels`) and
      their `envFromProcess` env-key mappings
      (`ANON_PI_EPHEMERAL`/`ANON_PI_CONFIG`/`ANON_PI_SOURCE_MODELS`) are removed.
- [ ] The corresponding `anon-pi.test.ts` describe blocks are deleted (listed
      above); `resolveAnonPiHome`, `hostPortKey`, and `pathSlug` blocks are KEPT.
- [ ] `pnpm -r build` + `pnpm -r test` are GREEN with no dead exports and no
      dangling references (a grep for the removed symbols in `src/` returns
      nothing but the deletion itself).
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] No shared/global writes (pure-module + test deletion only; any test that
      remains isolates writes to temp fixtures as before).

## Blocked by

- `cli-launch-surface-grammar-a` (removes the last `cli.ts` readers of these
  symbols; this task deletes them afterwards, so the build never breaks
  mid-chain).

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have
> drifted): confirm `cli-launch-surface-grammar-a` landed and `cli.ts` no longer
> reads `buildRunPlan`/`stateAgentDir`/`resolveConfigSeed`/`pickProviderForLlm`/
> `resolveSourceModelsPath` or the dead `AnonPiEnv` fields. If `cli.ts` (or any
> other `src/` file) STILL references one of them, do NOT delete it — route to
> needs-attention, because a reader still needs it (deleting would break the
> build). A quick `grep -rn <symbol> packages/anon-pi/src` (excluding the
> definition) confirms it is orphaned.

anon-pi was reworked from its 0.4.0 per-workdir model into a machines + projects
workspace. The pure module (`src/anon-pi.ts`) gained new resolvers, a new RunPlan
resolver, and a models.json generator; the CLI was rewritten onto them. That left
the OLD pure surface (`buildRunPlan`, `stateAgentDir`, `resolveConfigSeed`,
`pickProviderForLlm`, `resolveSourceModelsPath`, and the dead `AnonPiEnv`/env
fields) defined-but-unused, kept only so the CLI rewrite could land with a green
`pnpm -r build`.

Goal: delete that dead surface now that nothing reads it. Remove the five
functions, the dead `AnonPiEnv` fields + their `envFromProcess` env-key mappings,
and their `anon-pi.test.ts` describe blocks (`buildRunPlan*`, `stateAgentDir`,
`pickProviderForLlm`, `resolveSourceModelsPath`, the `resolveConfigSeed` cases in
`path resolution`, and the `envFromProcess mapping` block). KEEP
`resolveAnonPiHome`, `hostPortKey`, `pathSlug`, and everything new. This is
pure-code + test deletion, no behaviour change. "Done" = the symbols are gone,
`grep` finds no references in `src/`, and `pnpm -r build` + `pnpm -r test` are
green, with a changeset.

> RECORD nothing durable is decided here (pure removal); if you discover a symbol
> is NOT actually orphaned, that is a needs-attention route, not a silent keep.

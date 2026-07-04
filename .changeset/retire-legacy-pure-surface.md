---
'anon-pi': patch
---

Retire the orphaned legacy pure surface left over from the 0.4.0 per-workdir
model, now that `cli.ts` reads none of it. Pure code + test deletion, no
behaviour change.

Removed from `src/anon-pi.ts` (all dead once `cli-launch-surface-grammar-a`
rewrote the CLI onto the machines + projects resolvers): the five legacy
functions `buildRunPlan` (old per-workdir shape), `stateAgentDir`,
`resolveConfigSeed`, `pickProviderForLlm`, `resolveSourceModelsPath`; the dead
`AnonPiEnv` fields `ephemeral` / `configSeed` / `sourceModels` (plus
`piAgentDir`, orphaned with `resolveSourceModelsPath`) and their `envFromProcess`
env-key mappings (`ANON_PI_EPHEMERAL` / `ANON_PI_CONFIG` / `ANON_PI_SOURCE_MODELS`
/ `PI_CODING_AGENT_DIR`); and the now-unreferenced supporting declarations
(`RunPlan` interface, `ImportResult` interface, `legacyAnonPiHome`,
`BENIGN_API_KEYS`, the `isTruthy` helper) that existed only to serve them.

The corresponding `anon-pi.test.ts` describe blocks are deleted; the surviving
surface (`resolveAnonPiHome`, `hostPortKey`, `pathSlug`, the new layout/config
resolvers, `resolveRunPlan`, `generateModelsJson`) is kept untouched.

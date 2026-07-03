---
title: Generate models.json from the llm endpoint (pure)
slug: models-json-generation-from-llm
prd: machines-and-projects-workspace
blockedBy: [workspace-layout-and-config, launch-run-plan-resolution]
covers: [17]
---

## What to build

The pure generator that synthesizes a pi `models.json` provider from the global
`llm` endpoint (`host:port`), replacing the old `import`-from-host-models.json
flow. This is what `init` and the seed-if-fresh path use to seed each machine
home's `~/.pi/agent/models.json`.

In the pure module (`src/anon-pi.ts`):

- Given an `llm` endpoint value (a URL, `ip:port`, or bare ip — normalise with
  the existing `hostPortKey` helper), produce a barebones `models.json` carrying
  a single local provider pointed at that endpoint.
- Do NOT read the host's real pi models.json (that was the `import` model, now
  dropped) — the endpoint alone drives generation.
- Keep it pure (endpoint in → models.json object out); the CLI writes it into the
  machine home.

**This task OWNS retiring the `import`-source pure logic + its tests.** Because
`import` is dropped (no CLI path will call them after this task and
`cli-launch-surface-grammar-a`/`cli-init-onboarding`), remove
`pickProviderForLlm` and `resolveSourceModelsPath` and rewrite/delete the
`anon-pi.test.ts` cases pinned to them (the `pickProviderForLlm (import
selection)` and `resolveSourceModelsPath (import reads FROM)` describe blocks).
The `verify` gate runs `pnpm -r test`, so leave no red tests behind. (The
per-workdir `buildRunPlan`/`stateAgentDir` retirement is owned by
`launch-run-plan-resolution`; the `HELP`/`import`-dispatch retirement by
`cli-launch-surface-grammar-a`.)

## Acceptance criteria

- [ ] A `models.json` object is generated from an `llm` endpoint (URL / `ip:port`
      / bare ip all normalise via `hostPortKey`).
- [ ] The generated file carries ONLY the one local provider (no host secrets, no
      other providers — the anonymity hygiene the old `import` preserved).
- [ ] No host `~/.pi/agent/models.json` is read (the `import` source model is
      gone).
- [ ] The `import`-source pure logic is RETIRED: `pickProviderForLlm` and
      `resolveSourceModelsPath` are removed and the `anon-pi.test.ts` cases
      pinned to them are rewritten/deleted (no red tests remain).
- [ ] Tests cover the new behaviour (mirror existing pure-module test style):
      generation from each endpoint form, single-provider output.
- [ ] Every change produces a changeset; the `verify` gate passes (green
      `pnpm -r test`).
- [ ] Tests write nothing outside temp fixtures (the generator is pure; any
      file-write test isolates to a temp dir).

## Blocked by

- `workspace-layout-and-config` (uses the resolved `llm` value from config/env).
- `launch-run-plan-resolution` (SERIALIZED: both this task and the run-plan task
  edit `src/anon-pi.ts` + `test/anon-pi.test.ts` and retire legacy code there;
  ordering them avoids a same-file merge conflict, since there is no strict
  logical dependency but a real file collision).

## Prompt

> FIRST, check this task against current reality: confirm the config loader
> resolves `llm` (env over config) and that `import` is being dropped in favour of
> `init`. If a sibling already generates models.json, build on it rather than
> duplicate.

anon-pi seeds each machine home with a pi `models.json` so pi can reach the LOCAL
model directly (the single `--allow-direct` hole; everything else stays proxied).
Previously `anon-pi import` read the host's real models.json and picked the
matching provider; the rework DROPS `import` and generates the provider from the
`llm` endpoint captured by `anon-pi init`.

Goal: add a PURE `models.json` generator to `src/anon-pi.ts` that takes the `llm`
endpoint (normalise with the existing `hostPortKey` helper) and returns a
barebones single-provider `models.json`. It must NOT read the host's real pi
config (no leakage of other providers/keys). Keep it pure; `init` and
seed-if-fresh (other tasks) write it into the machine home.

Test the generator at its seam (each endpoint form → single-provider output).
You OWN retiring the `import`-source pure logic: remove `pickProviderForLlm` and
`resolveSourceModelsPath` and rewrite/delete their `anon-pi.test.ts` cases (the
`verify` gate runs `pnpm -r test`, so no red tests may remain). "Done" = the
generator + the retired import-source logic + tests all green under `verify`,
with a changeset.

> RECORD non-obvious in-scope decisions (the provider api shape) as a
> `## Decisions` note, or an ADR if it meets the gate.

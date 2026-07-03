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

**This task is ADDITIVE: it does NOT delete the old `import`-source logic.**
`cli.ts` still imports and calls `pickProviderForLlm` and
`resolveSourceModelsPath` (in its `import` subcommand), so removing them here
would break `pnpm -r build` before the CLI is migrated. ADD the new endpoint-driven
generator + its new tests, and LEAVE `pickProviderForLlm`/`resolveSourceModelsPath`
and their `anon-pi.test.ts` describe blocks in place, dead-but-present. Their
coordinated removal (together with the other legacy pure symbols and the `import`
CLI dispatch that reads them) is owned by `cli-launch-surface-grammar-a`, the task
that removes their last `cli.ts` readers so the build stays green.

**Same-file ordering.** This task is `blockedBy` `launch-run-plan-resolution`
only to SERIALIZE the additive edits both make to `src/anon-pi.ts` (each adds a
function; run-plan also renames the container-path constant), avoiding a
same-file merge conflict — there is no logical dependency and neither retires the
other's symbols.

## Acceptance criteria

- [ ] A `models.json` object is generated from an `llm` endpoint (URL / `ip:port`
      / bare ip all normalise via `hostPortKey`).
- [ ] The generated file carries ONLY the one local provider (no host secrets, no
      other providers — the anonymity hygiene the old `import` preserved).
- [ ] No host `~/.pi/agent/models.json` is read (the `import` source model is
      gone).
- [ ] This task is ADDITIVE: `pickProviderForLlm`/`resolveSourceModelsPath` and
      their `anon-pi.test.ts` blocks are LEFT IN PLACE (still called by `cli.ts`'s
      `import` path; removing them now breaks `pnpm -r build`). Their removal is
      owned by `cli-launch-surface-grammar-a`. No existing block is rewritten here.
- [ ] Tests cover the new behaviour (mirror existing pure-module test style):
      generation from each endpoint form, single-provider output.
- [ ] Every change produces a changeset; the `verify` gate passes (green
      `pnpm -r build` + `pnpm -r test`, old import-source symbols still present).
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
This task is ADDITIVE: do NOT remove `pickProviderForLlm`/`resolveSourceModelsPath`
or their test blocks — `cli.ts`'s `import` path still calls them, so removing them
now breaks `pnpm -r build`. Leave them dead-but-present; their removal is owned by
`cli-launch-surface-grammar-a` (which removes the last readers). This task is
`blockedBy` `launch-run-plan-resolution` only to serialize the additive
`src/anon-pi.ts` edits (avoid a same-file conflict); it does not depend on or
touch that task's symbols. "Done" = the new generator + its new tests green under
`verify` (`pnpm -r build` + `pnpm -r test`), with a changeset.

> RECORD non-obvious in-scope decisions (the provider api shape) as a
> `## Decisions` note, or an ADR if it meets the gate.

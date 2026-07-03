---
title: Workspace layout + config.json/machine.json load with env-override precedence
slug: workspace-layout-and-config
prd: machines-and-projects-workspace
blockedBy: []
covers: [15, 21]
---

## What to build

The pure foundation for the machines + projects workspace: the `~/.anon-pi/`
layout (overridable by `ANON_PI_HOME`, NOT under `~/.config`) and the loaders for
`config.json` (`{ proxy, llm, defaultMachine, projects? }`) and per-machine
`machine.json` (`{ image, projects? }`).

Deliver, in the pure module (`src/anon-pi.ts`), the resolvers and merge logic:

- Resolve `<anon-pi-home>` from `ANON_PI_HOME` else the built-in `~/.anon-pi/`.
- Load `config.json` and merge it with env overrides, honouring the decided
  precedence for the projects root: `--mount` (CLI, later task) > env
  `ANON_PI_PROJECTS` > `machine.json.projects` > `config.json.projects` >
  built-in `~/.anon-pi/projects/`. This task delivers the config/env layers of
  that chain (the `--mount`/machine layers are threaded in by later tasks that
  own resolvers/CLI); the resolver must be shaped so those layers slot in
  cleanly.
- Proxy/llm precedence: env (`ANON_PI_PROXY`/`ANON_PI_LLM`) overrides config. The
  **proxy is REQUIRED and never guessed**: if neither env nor config supplies it,
  fail closed with the existing verbatim guidance message (fail-closed is the
  anonymity invariant, keep it).

Keep everything pure and injectable (no filesystem reads inside the resolvers;
pass parsed config + env in, mirroring the existing `AnonPiEnv` pattern). The
old per-workdir seed/state model (`state/<slug>/agent`, `ANON_PI_CONFIG`,
`import`-oriented `resolveConfigSeed`) is being replaced; this task introduces the
new layout resolvers alongside, without yet deleting the CLI consumers (later
tasks migrate/remove them).

## Acceptance criteria

- [ ] `<anon-pi-home>` resolves to `ANON_PI_HOME` when set, else `~/.anon-pi/`
      (NOT `~/.config/anon-pi`).
- [ ] `config.json` parses to `{ proxy, llm, defaultMachine, projects? }` and
      `machine.json` to `{ image, projects? }`.
- [ ] Projects-root resolver applies the env > machine > config > built-in
      precedence (with a documented slot for the later `--mount` CLI override on
      top).
- [ ] Proxy/llm: env overrides config; a missing proxy fails closed with the
      existing required-proxy guidance (never a guessed default).
- [ ] Tests cover the new behaviour (mirror the repo's existing pure-module test
      style in `packages/anon-pi/test/`): config load, each precedence layer,
      env-over-config, and the fail-closed missing-proxy path.
- [ ] Every change produces a changeset (`pnpm changeset`); the `verify` gate
      (`pnpm format:check && pnpm changeset status --since=main && pnpm -r build
      && pnpm -r test`) passes.
- [ ] Tests ISOLATE any home/config read: inject the anon-pi home via env/args at
      a temp dir; assert no real `~/.anon-pi` is read or written.

## Blocked by

- None — can start immediately.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have
> drifted): confirm `src/anon-pi.ts` still holds the pure logic and `src/cli.ts`
> the spawn/TUI (the pure/impure split), and that the current model is still the
> per-workdir `state/<slug>/agent` one this task begins to replace. If a sibling
> task already introduced the new layout, build on it; if the split changed,
> route to needs-attention rather than assume.

You are reworking anon-pi (a host-side launcher for the netcage jail) from its
0.4.0 per-workdir model into a machines + projects workspace. Domain vocabulary
(see `CONTEXT.md`): a **machine** is an image + a persistent host **home**
(`machines/<M>/home`, bind-mounted at `/root`); a **project** is a folder under
the **projects root** (mounted at `/projects`); the **proxy** is the required,
never-guessed socks5h endpoint that forces egress (fail-closed).

Goal: land the pure workspace-layout foundation in `src/anon-pi.ts`. The new
layout is `~/.anon-pi/` (overridable by `ANON_PI_HOME`) holding `config.json`,
`machines/<M>/{machine.json,home/}`, and the default global projects root
`projects/`. Implement `config.json`/`machine.json` shapes and the load+merge
resolvers with the decided precedence (projects-root: env `ANON_PI_PROJECTS` >
`machine.json.projects` > `config.json.projects` > built-in; proxy/llm: env over
config; proxy REQUIRED/fail-closed). Keep it PURE (inject config + env; the
existing `AnonPiEnv` injection pattern is the model) so it is unit-testable, and
shape the projects-root resolver so the later `--mount` (CLI) override slots on
top cleanly.

Test at the resolver seam with a temp anon-pi home, covering each precedence
layer and the fail-closed missing-proxy error (keep the existing verbatim
proxy-required guidance message). Do NOT touch `cli.ts` consumers of the old
`state/<slug>` model here (later tasks migrate them). "Done" = the pure loaders +
precedence + tests are green under the `verify` gate, with a changeset committed.

> RECORD non-obvious in-scope decisions as an ADR (`docs/adr/`) if they meet the
> ADR gate, else a `## Decisions` note in the done record.

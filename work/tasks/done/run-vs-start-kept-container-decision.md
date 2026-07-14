---
title: Run-vs-start decision rule for kept (netcage.managed) containers
slug: run-vs-start-kept-container-decision
spec: machines-and-projects-workspace
blockedBy: [launch-run-plan-resolution]
covers: [12]
---

## What to build

The pure DECISION rule (with a clean impure seam for the query) that tells the
CLI whether a `--keep` launch should `netcage run` a fresh container or
`netcage start` an existing kept one.

In the pure module (`src/anon-pi.ts`):

- Given the resolved launch (machine, projects-root, project) and a supplied
  listing of kept `netcage.managed` containers, DECIDE: a matching kept container
  present → `start` it; else → `run` (without `--rm`). Only relevant to the
  `--keep` path; `--rm` launches are always a fresh `run`.
- Define the match key from the (machine, projects-root, project) identity so the
  right kept container is resumed (no anon-pi-owned registry file — netcage's
  `netcage.managed` label IS the record).
- Keep the QUERY (how to actually ask netcage for its labelled containers) as an
  injected function / impure seam the CLI supplies; the DECISION rule itself is
  pure and unit-tested.

## Acceptance criteria

- [ ] Pure decision: kept matching container present → `start`; absent → `run`
      (no `--rm`), for the `--keep` path.
- [ ] `--rm` launches always resolve to a fresh `run` (never `start`).
- [ ] The match key is derived from (machine, projects-root, project) — no
      registry file; the `netcage.managed` label is the source of truth.
- [ ] The netcage-query is an injected seam (impure), kept out of the pure rule.
- [ ] Tests cover the new behaviour (mirror existing pure-module test style):
      present/absent kept container, `--rm` short-circuit, and match-key
      correctness against a fixture listing.
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] Tests ISOLATE any state; no real netcage/podman is invoked in unit tests
      (the query is injected).

## Blocked by

- `launch-run-plan-resolution` (needs the resolved launch identity + `--rm`/keep
  field; shares `src/anon-pi.ts`).

## Prompt

> FIRST, check this task against current reality: confirm the RunPlan resolver
> landed with a `--rm`/keep field and a resolvable (machine, projects-root,
> project) identity. If those differ, adapt or route to needs-attention.

anon-pi builds ENTIRELY on netcage v0.4.0 as shipped: kept containers, `netcage
start`, `--rm`, and the `netcage.managed` label (no netcage change is required).
The exploratory flow (`--keep`): run a container, `apt install`, quit, re-enter
with the SAME launch and resume it via `netcage start` (the container filesystem
survives). Throwaway (`--rm`) is the default and always a fresh `run`.

Goal: add the pure run-vs-start decision rule to `src/anon-pi.ts`. Given the
resolved launch and a supplied listing of kept `netcage.managed` containers,
decide `start` (match present) vs `run` without `--rm` (absent). Derive the match
key from the (machine, projects-root, project) identity; do NOT invent an
anon-pi registry file — netcage's label is the record. Keep the netcage QUERY an
injected impure seam so the DECISION stays pure and unit-testable.

Test the decision at its seam with fixture listings (present / absent / `--rm`
short-circuit). "Done" = the pure rule + injected query seam + tests green under
`verify`, with a changeset. The CLI that calls the real query + spawns is a later
task.

> RECORD non-obvious in-scope decisions (the exact match-key fields) as an ADR if
> they meet the gate, else a `## Decisions` note.

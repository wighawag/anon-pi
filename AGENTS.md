# AGENTS.md — anon-pi

Instructions for agents working in this repository.

## Per-change convention (REQUIRED, enforced)

**Every change requires a changeset.** Run `pnpm changeset` and commit the
generated `.changeset/*.md` file as part of your change. This is not optional:
the `.dorfl.json` `verify` gate runs `pnpm changeset status --since=main`, so a
change branch that adds no changeset FAILS the gate and cannot land.

- Pick the bump level honestly (`patch` / `minor` / `major`) for the
  `anon-pi` package per semver.
- A purely internal change with no user-facing effect still needs a changeset
  (an empty/patch changeset documenting it) so the gate passes and the release
  notes stay complete.

## Build / test gate

The acceptance gate (`.dorfl.json` `verify`) is:

```
pnpm format:check && pnpm changeset status --since=main && pnpm -r build && pnpm -r test
```

Env-prep (run once before the first verify on a fresh worktree) is
`pnpm install --frozen-lockfile` (`.dorfl.json` `prepare`). Keep install OUT of
`verify`.

## Domain

See `CONTEXT.md` for the domain glossary (netcage, machine, project, home,
projects root, proxy, forced-egress). anon-pi is a host-side launcher for
netcage; netcage owns the jail. Never weaken netcage's forced-egress invariant.

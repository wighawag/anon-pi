# AGENTS.md — anon-pi

Instructions for agents working in this repository.

## Changeset convention

**A change that affects users of the published `anon-pi` package needs a
changeset.** Run `pnpm changeset` and commit the generated `.changeset/*.md`
file as part of that change. This is what drives the version bump + the release
notes, so it is scoped to user-facing change, NOT to every commit.

- **Needs a changeset:** anything that changes the package's behaviour, CLI
  surface, output, or public API for someone who installs `anon-pi` (a feature,
  a fix, a breaking change, a user-visible message change). Pick the bump level
  honestly (`patch` / `minor` / `major`) per semver.
- **Does NOT need a changeset:** a change with no effect on the published
  package's users, e.g. edits under `work/` (PRDs, tasks, notes), repo docs
  (`README` excepted when it ships user guidance), CI/tooling config, or a
  test-only / internal refactor that leaves behaviour identical. Adding an
  empty changeset for these just clutters the release notes; skip it.
- **The gate does NOT force a changeset.** `pnpm changeset status --since=main`
  reports pending bumps and exits 0 whether or not a changeset is present, so a
  changeset-free internal change still passes `verify`. (An earlier version of
  this file wrongly claimed every change is required and that the gate fails
  without one; neither is true.)
- When in doubt, ask "does someone who `npm install`s anon-pi see or feel this?"
  If no, no changeset.

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

# AGENTS.md — anon-pi

Instructions for agents working in this repository.

## Changeset convention

**A change that touches the published `anon-pi` package needs a changeset; a
change that does not, does not.** Run `pnpm changeset` and commit the generated
`.changeset/*.md` file as part of any change under `packages/`. The requirement
is scoped to the package (its behaviour + release notes), NOT to every commit,
and the gate ENFORCES exactly that scope (see below) — so this is not merely a
convention you could forget, it is checked.

- **Needs a changeset (gate ENFORCES it):** any change to `packages/anon-pi/**`
  (source, or the package's own files). `pnpm changeset status --since=main`
  errors + EXITS NON-ZERO when a package changed with no changeset, so `verify`
  FAILS and the change cannot land. Pick the bump level honestly (`patch` /
  `minor` / `major`) per semver; a package change that genuinely needs no
  release (e.g. a comment-only edit) still needs an entry, use
  `pnpm changeset add --empty`.
- **Does NOT need a changeset (gate PASSES without one):** a change that touches
  NO package — edits under `work/` (PRDs, tasks, notes), root repo docs
  (`AGENTS.md`, top-level docs), CI/tooling config outside `packages/`. Because
  nothing under `packages/` changed, `changeset status` finds nothing to require
  and exits 0, so `verify` passes with no changeset. Do NOT add an empty
  changeset for these — it wrongly bumps the package + clutters the release
  notes.
- **The dividing line the gate actually uses is "did a package change", which
  tracks "does a published-package user feel this".** They coincide: package
  source is what ships to `npm install`, and `work/`/root-docs do not. When in
  doubt, ask "did I touch `packages/`?" — if yes, changeset; if no, none.

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

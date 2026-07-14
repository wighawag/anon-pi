# AGENTS.md — anon-pi

Instructions for agents working in this repository.

## Changeset convention

**A change that touches the published `anon-pi` package needs a changeset; a
change that does not, does not.** Run `pnpm changeset` and commit the generated
`.changeset/*.md` file as part of any change under `packages/`. The requirement
is scoped to the package (its behaviour + release notes), NOT to every commit,
and the gate ENFORCES exactly that scope (see below) — so this is not merely a
convention you could forget, it is checked.

**Why this rule exists:** primarily to stop an autonomous (dorfl) agent from
cutting a `work/<slug>` branch that IMPLEMENTS code without a release note. It
applies equally to a human-in-loop session THAT CHANGES CODE (a human code
change also gets its changeset). It does NOT apply to a change with no package
code in it.

**Corollary — a docs-only / `work/`-only change needs NEITHER a changeset NOR a
gate run.** Because the whole gate keys on `git diff` under `packages/`, a commit
that touches only `work/`, root docs (`AGENTS.md`, top-level docs), or tooling
has nothing for `verify` to check: no build to break, no test to fail, no
changeset to require. Do not add a changeset AND do not bother running
`pnpm -r build && pnpm -r test` for it — there is nothing it can catch. Run the
gate when you changed code.

- **Needs a changeset (gate ENFORCES it):** any git-tracked change under
  `packages/anon-pi/` — NOT just published source (keys on the package
  DIRECTORY, not the `files` publish list; see the detailed rule under the gate
  below). `pnpm changeset status --since=main` errors + EXITS NON-ZERO when such
  a file changed with no changeset, so `verify` FAILS and the change cannot
  land. Pick the bump level honestly (`patch` / `minor` / `major`) per semver; a
  package change that genuinely needs no release (a test/tsconfig/comment-only
  edit) still needs an entry — use `pnpm changeset add --empty`.
- **Does NOT need a changeset (gate PASSES without one), and needs no gate run:**
  a change with NO git-tracked file under `packages/anon-pi/` — edits under
  `work/` (specs, tasks, notes), root repo docs (`AGENTS.md`, top-level docs),
  CI/tooling config outside the package. Also gitignored package files
  (`dist/**`, the build-copied `packages/anon-pi/README.md`) do NOT count
  (`git diff` cannot see them). `changeset status` finds nothing to require and
  exits 0. Do NOT add an empty changeset for these (it wrongly bumps the package
  + clutters release notes), and do not bother running the gate.
- **The exact test is NOT "would a user feel this" — it is "did I change a tracked
  file under `packages/`".** These do NOT fully coincide: a `test/**` or
  `tsconfig.json` edit that no `npm install` user ever sees STILL needs a
  changeset, because it lives under the package dir. When in doubt, ask "did I
  change a tracked file under `packages/anon-pi/`?" — if yes, changeset (possibly
  `--empty`) + run the gate; if no, neither.

## Build / test gate

The acceptance gate (`dorfl.json` `verify`) is:

```
pnpm format:check && pnpm changeset status --since=main && pnpm -r build && pnpm -r test
```

Env-prep (run once before the first verify on a fresh worktree) is
`pnpm install --frozen-lockfile` (`dorfl.json` `prepare`). Keep install OUT of
`verify`.

`pnpm changeset status --since=main` is the changeset check: it EXITS NON-ZERO
(failing `verify`) when a TRACKED file under `packages/anon-pi/` changed with no
changeset (source, tests, tsconfig, package.json — the package DIRECTORY, not the
publish `files` list), and exits 0 when no such package file changed (so a
`work/`-only, root-docs-only, or gitignored-`dist`/`README` change passes with
no changeset). It compares against `main`, so it only sees what your branch
changed.

## Domain

See `CONTEXT.md` for the domain glossary (netcage, machine, project, home,
projects root, proxy, forced-egress). anon-pi is a host-side launcher for
netcage; netcage owns the jail. Never weaken netcage's forced-egress invariant.

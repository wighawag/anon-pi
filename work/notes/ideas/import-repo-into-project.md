---
title: Import a host repo into a fresh project and launch pi into it, in one command
slug: import-repo-into-project
---

# Import a host repo into a project (fresh-clone semantics, identity-stripped)

Proposed idea. A single command that takes a repo already on your host, copies
it into a **new project** under the projects root (mounted at `/projects`), and
launches pi into that copy, all in one go. The copy reproduces the effect of a
**fresh `git clone`** (real `.git`, only non-ignored files) while stripping YOUR
identity, so the jailed project is a clean, anonymized working copy of the repo,
never a mount of your real working tree.

## Context & problem

Today there is no one-liner for "I have a repo here, work on it anonymously".
The two existing paths both miss:

- `anon-pi <project>` creates an **empty** folder on demand. No import of an
  existing repo.
- `anon-pi --mount <host-parent> <sub>` mounts your **real** host tree in place
  (edits your actual files; `<parent>` is a parent dir, not the repo). No copy,
  no isolation, no identity scrub.

The gap: take *this* repo, make an isolated **copy** as a normal project (menu-
listable, resumable, `--delete-project`-able), stripped of identifiers, and
launch pi into it. A copy (not a mount) means the jailed pi cannot touch your
real working tree, and the project behaves like any other project.

## The use case that pins the semantics (settled in discussion)

The driving case is **a third-party repo you cloned from GitHub** and want to
work on anonymously. Its upstream `.git` identity (their `origin`, their commit
history) is public and not your concern. What must be stripped is **YOUR**
identity, which can appear in a clone you have worked in:

- `.git/logs/` (the **reflog**): records your local ops stamped with your
  `user.name`/`user.email` + local timezone.
- **Local commits** you made on top of upstream: author/committer = you, baked
  into the commit objects.
- `.git/config`: usually just upstream's `origin`, but yours if you set a local
  `user.email`, added your fork, or used an authenticated URL.

### Decisions locked in

1. **git-aware copy** — do NOT copy gitignored files (drops `node_modules`,
   `.env`, build junk; also removes an identifier/secret surface). Goal #1.
2. **Collision = refuse** — if the target project name already exists under the
   projects root, refuse (do not overwrite or sync).
3. **Keep `.git`** — the point is to keep working on the repo WITH git: pi can
   `git diff`/`git log`/commit, and your improvements are real commits you can
   extract (`git format-patch`/`push`) out of the jail. So this is NOT a
   drop-`.git` snapshot.
4. **Global** — the copy lands under the global projects root (`~/.anon-pi/
   projects/<name>`), shared across machines, consistent with the model.

### The key realization: "keep .git but not gitignored files" == a fresh clone

Keeping `.git` while excluding gitignored files is **not** contradictory: that
is exactly what a fresh `git clone` produces (full `.git`, working tree from
HEAD, no gitignored junk because it was never committed). The only nuance is we
also want your **uncommitted / untracked-but-not-ignored** work-in-progress to
travel (a literal `git clone --local` would drop it, since it rebuilds from the
object store). rsync driven by git's own ignore engine solves that.

## Implementation & technical thoughts

Fuse two copies (real `.git` + git-filtered working tree), then sanitize
identity. Let **git** decide which working-tree files travel (its ignore engine
is exact; rsync's `--filter=:- .gitignore` is only an approximation and can leak
on nested ignores / negations / global excludes, wrong for a privacy boundary).

```sh
SRC=/path/to/repo
DEST="$ANON_PI_HOME/projects/<name>"     # refuse if it already exists

# capture the REAL upstream url before we touch anything
upstream=$(git -C "$SRC" remote get-url origin 2>/dev/null)

mkdir -p "$DEST"

# 1) copy .git verbatim -> real git in the jail
rsync -a "$SRC/.git/" "$DEST/.git/"

# 2) copy the WORKING TREE, but let GIT pick the files:
#    --cached   = tracked files (as on disk, so uncommitted edits travel)
#    --others   = untracked files...
#    --exclude-standard = ...honoring .gitignore/info/exclude/global excludes
#    => WIP + new files travel; gitignored junk is dropped, accurately
git -C "$SRC" ls-files -z --cached --others --exclude-standard \
  | rsync -a --files-from=- --from0 "$SRC/" "$DEST/"

# 3) sanitize YOUR identity (keep upstream history + a real origin)
if [ -n "$upstream" ]; then
  git -C "$DEST" remote set-url origin "$upstream"   # real upstream, NOT a host path
else
  git -C "$DEST" remote remove origin 2>/dev/null || true
fi
git -C "$DEST" config user.name  "anon"
git -C "$DEST" config user.email "anon@localhost"
git -C "$DEST" reflog expire --expire=now --all
rm -rf "$DEST/.git/logs"
```

Then launch exactly as `anon-pi <name>` (byte-for-byte the normal project
launch), so resume/menu/delete all behave identically.

### Why this shape (each guarantee)

- ✅ `.git` kept, real git in the jail (diff, log, commit, extract improvements).
- ✅ working tree **as it sits now**: uncommitted edits AND new untracked files
  travel (rsync copies the real tree; git decides the file set).
- ✅ gitignored junk dropped by **git's** engine (accurate, not rsync's fuzzy
  filter).
- ✅ `origin` = the true upstream URL (or removed) — never a host path. The
  host-path-in-origin leak only happens with `git clone <local-path>`, which we
  deliberately do NOT do.
- ✅ reflog gone; future commits stamped `anon`, not you.

### The one honest residual

Copying `.git` verbatim also brings any **local commits you already made** on
top of upstream, whose author/committer identity stays baked in the commit
objects. Only a history rewrite (`git filter-repo --mailmap`) scrubs that, which
is heavier and out of scope for v1. For a **fresh third-party clone you are
about to start on** (the driving case) there are no such commits, so it is
clean. Document this plainly; offer the rewrite only if a user needs it.

Also: a file that is **gitignored yet tracked** (someone `git add -f`'d it) will
travel — correct, a tracked file should. The rule is exactly: tracked always
travels; only untracked-and-ignored is dropped.

## Command surface (open product choices)

- **Verb vs flag.** A verb reads best: `anon-pi import <path> [<name>]`. BUT
  `import` was the REMOVED 0.4.0 verb — reusing the name risks confusion.
  Candidates: `anon-pi clone-in <path>`, `anon-pi from <path>`, or a launch flag
  `anon-pi --from <path> <name>` (reuses the whole existing launch path; `--from`
  just pre-copies before the standard `<project>` launch runs).
- **Default project name** = the source repo's basename; refuse on collision
  (decision #2).
- **origin default**: keep pointing at real upstream (enables `git fetch`
  upstream through the proxy) vs drop it. Leaning: keep.
- **anon identity**: fixed `anon@localhost` vs configurable (a chosen pseudonym
  from `config.json`), so a user can pick a stable non-real identity for the
  commits pi makes.

## Future extensions

- A `--squash`/`--anon-history` option that rewrites existing local commits to
  the anon identity (`git filter-repo`) for users who HAVE committed under their
  real name and care about the residual surface above.
- A `--no-git` variant (drop `.git` entirely: `git archive HEAD` or
  `ls-files | rsync` with no `.git/` copy) for "clean plain folder, pi `git
  init`s its own" — the strictest zero-identifier option, if ever wanted.
- Offer import from a **URL** too (clone through the proxy into a project),
  though that is a different flow (network fetch, not local copy).

## Composes with

- The bare menu / normal project model: an imported repo is just a project, so
  menu, resume-by-cwd, `--delete-project`, and `-m <machine>` all work unchanged.
- The `--ephemeral` idea: import is the opposite (you WANT to keep the work);
  they are alternate entry points, not conflicting.

## Open threads

- Final command name (verb vs `--from`); avoid the retired `import` if it
  confuses.
- Whether the copy should run BEFORE the image/proxy checks (fail fast on a bad
  path) or after.
- Progress/scale: large repos — surface rsync progress; refuse or warn on very
  large trees?
- Windows/macos-via-VM: the recipe is plain git+rsync, host-side, so it should
  be VM-agnostic, but confirm rsync availability assumptions.
- Should `.git/config` sanitize also strip `[user]`/signing keys/`[credential]`
  blocks if present, not just origin+reflog?

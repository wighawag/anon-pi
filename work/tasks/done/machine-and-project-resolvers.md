---
title: Machine + project resolvers, name validation, and the "." root token
slug: machine-and-project-resolvers
spec: machines-and-projects-workspace
blockedBy: [workspace-layout-and-config]
covers: [8, 9, 16]
---

## What to build

The pure resolvers that turn machine + project names into on-host paths and jail
cwds, plus name validation and the `.` root token.

In the pure module (`src/anon-pi.ts`), deliver:

- **Machine resolvers**: machine dir (`machines/<M>/`), `machine.json` (image),
  and machine home dir (`machines/<M>/home`, the ONE mount at `/root`).
- **Project resolvers**: a project name → the projects-root subfolder on the host
  and the jail cwd `/projects/<name>` (pi's conversation key). Use the
  projects-root resolver from the layout task (env/machine/config/built-in
  precedence) as the parent.
- **Name validation** for machines and projects: reject `/ \ :`, `..`,
  leading-dot, and whitespace; reject reserved names. Return a clear
  `AnonPiError` on a bad name. (The `--mount` namespace reserves its own token —
  keep validation shaped so the mount/`/work` distinction from the launch task
  composes cleanly.)
- **The `.` root token**: a project token meaning "the root itself" — cwd
  `/projects` (or `/work` under `--mount`, or `~` for a machine). Resolve `.`
  uniformly so `anon-pi --mount <p> .` and a menu "here" entry both use it.

Keep it pure (paths in/out, no filesystem side effects); the CLI wires these to
real dirs later.

## Acceptance criteria

- [ ] Machine resolvers return the machine dir, `machine.json` path, and home dir
      (`/root` mount source) for a machine name.
- [ ] Project resolver maps `<name>` → host projects-root subfolder + jail cwd
      `/projects/<name>`, using the resolved projects root as parent.
- [ ] Name validation rejects `/ \ : .. leading-dot whitespace` and reserved
      names with an `AnonPiError`; valid names pass.
- [ ] The `.` root token resolves to the root cwd (`/projects`, `/work` for
      `--mount`, or `~` for a machine) uniformly.
- [ ] Tests cover the new behaviour (mirror the existing pure-module test style):
      each resolver, the full validation reject/accept matrix, and `.` in each
      root context.
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] Tests ISOLATE any path derivation against a temp anon-pi home; no real
      `~/.anon-pi` is touched.

## Blocked by

- `workspace-layout-and-config` (this task builds on the layout + projects-root
  resolver it lands, and shares `src/anon-pi.ts`).

## Prompt

> FIRST, check this task against current reality: confirm
> `workspace-layout-and-config` landed the `~/.anon-pi/` layout + projects-root
> precedence resolver, and build the machine/project resolvers on top of it. If
> that task resolved the projects-root shape differently than assumed here, adapt
> or route to needs-attention rather than duplicate it.

anon-pi is a host-side launcher for the netcage jail, being reworked into a
machines + projects workspace. Vocabulary (`CONTEXT.md`): a **machine** = image +
persistent host **home** (`machines/<M>/home` → `/root`); a **project** = a
folder under the **projects root** → `/projects/<name>` (pi's conversation key,
since pi keys a session by its launch cwd).

Goal: add the pure machine + project resolvers, name validation, and the `.`
root token to `src/anon-pi.ts`. Machine resolvers give the machine dir /
`machine.json` / home dir; project resolvers map a name to its host subfolder and
jail cwd `/projects/<name>` off the resolved projects root. Validate machine +
project names (reject `/ \ : .. leading-dot whitespace` and reserved names,
raising `AnonPiError`). Resolve `.` to "the root itself" uniformly across
`/projects`, `--mount`'s `/work`, and a machine's `~`.

Keep everything PURE and unit-tested at the resolver seam (temp anon-pi home).
"Done" = resolvers + validation + `.` token + tests green under `verify`, with a
changeset. Do NOT compose the netcage argv here (the launch-run-plan task owns
that) — just the name→path resolution these build on.

> RECORD non-obvious in-scope decisions (e.g. the reserved-name set) as an ADR if
> they meet the gate, else a `## Decisions` note.

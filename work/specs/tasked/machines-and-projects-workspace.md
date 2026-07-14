---
title: Machines + projects workspace model (rebuilt on netcage v0.4.0 lifecycle)
slug: machines-and-projects-workspace
humanOnly: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked — they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

## Problem Statement

Today (anon-pi 0.4.0) a launch is `anon-pi [WORKDIR]`: it mounts a host work
folder as pi's cwd and keeps a **per-workdir** state home
(`~/.config/anon-pi/state/<workdir-slug>/agent`) mounted at the container's
`~/.pi/agent`. Each launch is a fresh throwaway `netcage run --rm` that re-seeds
and re-jails. This has three problems the user feels:

1. **Config/extensions are duplicated per workdir.** Two projects can't share one
   pi config + extension set without copying; the home is keyed to the workdir,
   not to an environment the user owns.
2. **There is no notion of a durable, named, anonymized environment** ("my
   machine") that a user returns to, nor a way to play with system tools inside a
   jail and come back to them.
3. **The model predates netcage v0.4.0's container lifecycle** (kept containers +
   `netcage start` + `--rm` semantics + management verbs). anon-pi re-invents
   persistence via volume-mounts over a throwaway container instead of building on
   netcage's shipped primitives.

The user wants: a small set of **machines** (each an image + a persistent,
inspectable home) that they run pi on, **projects** that are just folders they
work in (with pi conversations that resume), a **menu** on bare launch so they
don't have to remember what to type, and the ability to **poke around a jailed
machine in a shell** (pi cannot change directory mid-session, so the shell is the
project-hopper). All of it must keep netcage's forced-egress invariant intact.

## Solution

Rework anon-pi into a **machines + projects** workspace, built on netcage v0.4.0.

- **Machine** = an image + a persistent HOST home (`~/.anon-pi/machines/<M>/home`,
  bind-mounted at `/root`). It holds shell config, pi config + extensions, and pi
  conversations (`~/.pi/agent/sessions/`). The container is disposable; ALL
  valuable state is in this host home. One machine concept (no stable-vs-
  exploratory type).
- **Project** = a folder under a **projects root**, mounted at `/projects/<name>`
  (pi's cwd). The projects root is GLOBAL by default (`~/.anon-pi/projects/`,
  shared across machines), configurable, and per-launch overridable with
  `--mount`. Projects are just files, image-agnostic.
- **Two invariant container mounts**, always: `/root` (the machine home) and
  `/projects` (the projects root). Nothing else changes between launches — a
  different project is just a different cwd; a different host root is `--mount`.
  This sidesteps podman's mount-immutability entirely (we never remount).
- **Launch surface** (grammar: a bare positional is a PROJECT; `-m` picks the
  machine):
  - `anon-pi` → an interactive **menu** (arrow-select): the machine's projects
    (each → pi), `+ new project…`, and `shell`.
  - `anon-pi <project>` → pi in `/projects/<project>`, exit pi → back to host.
  - `anon-pi <project> <pi-args…>` → forward args to pi (headless/one-shot; no
    TTY required).
  - `anon-pi --shell [<project>]` → a jailed bash (at `~`, or cd'd into the
    project). The "sit on the machine / hop projects" mode.
  - `anon-pi -m <machine> [<project>]` → same, on `<machine>`.
  - `anon-pi --mount <parent> [<project>]` → root at a HOST parent folder instead
    of the projects root; same menu / project / `.` rules; shared machine home.
  - `[--rm]` → throwaway container this run (the DEFAULT for all launches);
    `[--keep]` → leave the container kept so its filesystem survives (the
    exploratory "apt install, quit, re-enter" flow; anon-pi finds the kept
    container by netcage's `netcage.managed` label and `netcage start`s it).
- **`.`** is a project token meaning "the root itself" (cwd `/projects` or
  `/work` for `--mount`, or `~` for a machine): usable as `anon-pi --mount <p> .`
  and offered as a menu entry (a scratch pi at the root). Works uniformly.
- **Conversations are per-machine, files are (by default) global**: the same
  project folder is shared across machines, but each machine keeps its own pi
  history (sessions live in that machine's home, keyed by the `/projects/<name>`
  cwd). The menu ANNOTATES each project with the machines it has been used on
  (derived from the presence of pi session dirs — no marker file needed) and
  flags whether the current machine is new for it.
- **`anon-pi init`** onboards: detect + SOCKS5-confirm + `netcage verify` the
  proxy (never labelling the exit provider), capture the local-model endpoint
  (replacing `import`), pick/build the default machine image, write
  `config.json`. Re-runnable.
- **`~/.anon-pi/`** is the dedicated, browsable workspace folder (config +
  per-machine homes + global projects), NOT under `~/.config`.

## User Stories

1. As a user, I want `anon-pi` (bare) to show me an arrow-key MENU of my
   projects (plus "new project" and "shell"), so I don't have to remember a name
   or a flag to get going.
2. As a user, I want each project in the menu to show which machines it has been
   used on (and whether the current machine is new for it), so I can find where a
   conversation lives without guessing.
3. As a user, I want `anon-pi <project>` to drop me straight into pi working in
   that project, and exiting pi to return me to my host shell, so a focused
   session is one command in and out.
4. As a user, I want `anon-pi <project>` to RESUME my prior conversation for that
   project on that machine, so I can continue where I left off (because the
   machine home + the `/projects/<name>` cwd are the same, pi finds the session).
5. As a user, I want `anon-pi <project> <pi-args…>` to forward arguments to pi
   (e.g. a headless one-shot prompt), and to work without a TTY, so anon-pi is
   scriptable.
6. As a user, I want `anon-pi --shell [<project>]` to give me a jailed bash on the
   machine, so I can navigate, run pi per project, run tmux / multiple pis, and
   generally "sit on the machine" (the shell is how I hop projects, since pi
   cannot cd mid-session).
7. As a user, I want to quit pi and be back on the machine shell (when I launched
   via `--shell`), and to leave the machine by exiting that shell, so it feels
   like using my own computer.
8. As a user, I want `anon-pi -m <machine> [<project>]` to run on a specific
   machine (with its own image + home + conversations), so I can keep separate
   anonymized environments.
9. As a user, I want a new project to need a specific image to just be a new
   machine (new image, new home), and I do NOT expect it to share conversations
   with my other machines.
10. As a user, I want the SAME project folder to be usable from more than one
    machine (shared files) while each machine keeps its OWN conversation history,
    so I can work the same code with a fresh anonymized environment/perspective.
11. As a user, I want throwaway to be the DEFAULT: every launch removes its
    container on exit (`--rm`), leaving no container residue — because everything
    I care about is in the persistent host home, not the container.
12. As a user, I want `--keep` to leave the container kept, so I can `apt install`
    / tweak the system inside a jailed shell, quit, and re-enter later with that
    system state intact (anon-pi resumes it via `netcage start`).
13. As a user, I want `anon-pi --mount <parent>` to root me at a HOST folder (a
    projects-root of my own, e.g. `~/dev/anon-projects`) instead of the internal
    projects root, with the SAME menu / project / shell behaviour, so I can jail
    pi into folders I edit with host tools.
14. As a user, I want `anon-pi --mount <parent> <project>` to pi directly into a
    subfolder while the whole parent is still mounted (siblings reachable), so a
    multi-project host folder works like the internal projects root.
15. As a user, I want a config/env setting for a DEFAULT projects root, so bare
    `anon-pi` uses my dev folder without me passing `--mount` every time (the
    `<anon-pi>` folder then holds only homes + config).
16. As a user, I want `.` (or a menu "here" entry) to mean "pi in the root
    itself" (the mount/projects root, or the machine home) for a quick session not
    tied to a subfolder.
17. As a user, I want `anon-pi init` to walk me through choosing + VERIFYING my
    proxy (showing the real exit IP, never claiming a provider it can't prove), my
    local-model endpoint, and my default machine image, so onboarding is honest
    and evidence-based.
18. As a user, I want `anon-pi machine {create,list,set-image,rm}` to manage my
    machines (create with an image, list them, re-pin an image with a warning,
    delete a machine + its home), so machines are first-class.
19. As a user, I want `anon-pi --delete-home [<machine>]` and
    `anon-pi --delete-project <project>` to clean up a machine's home
    (config + convos) or a project's files + that project's per-machine sessions,
    with confirmation, so I can reset state deliberately.
20. As a user, I want the forced-egress jail to hold on EVERY path (menu, pi,
    shell, mount, keep, rm): all web/DNS egress through the proxy, fail-closed,
    with the one direct hole for my local model — anon-pi never weakens netcage's
    invariant.
21. As a user, I want config precedence to be sensible: `--mount`/CLI overrides
    env (`ANON_PI_PROXY`/`ANON_PI_LLM`/`ANON_PI_PROJECTS`) which overrides
    `config.json`, and the proxy is REQUIRED (never guessed), so I can script and
    override without editing config, but never accidentally run un-anonymized.
22. As a user migrating from 0.4.0, I want a clear migration note (a bare
    positional is now a PROJECT not a host path; `import`/`--fresh`/`--ephemeral`
    are gone; old `state/<slug>/` is not migrated), so the breaking change doesn't
    silently surprise me.

### Autonomy notes (the two gate axes)

- **`humanOnly: true` (DECIDED).** A human must drive the TASKING of this spec.
  This is a foundational rework of anon-pi's whole CLI + workspace model with
  several deliberate cuts (the menu split, the throwaway-default, the global-
  projects-with-per-machine-conversations model, the `--mount`/`.` symmetry). The
  cut of these into tasks wants a human's eye. NOTE: this does NOT propagate to
  the tasks' own gates — the resulting tasks may well be fully agent-buildable;
  the tasker decides each task's gate from its own build-nature.
- **`needsAnswers`: OMITTED (resolved).** The two prior open questions are
  DECIDED and OUT OF SCOPE for this spec (see Out of Scope): (a) a fully-stateless
  "no host state at all" mode (the old `--ephemeral`) is dropped for now; (b)
  baking an exploratory machine into an image (a `netcage commit` dependency /
  an anon-pi `bake` verb) is dropped for now. The spec is otherwise complete and
  straightforwardly taskable.

<!-- TASKED: the Implementation/Testing detail that was here has moved into the
     tasks (work/tasks/) and the durable rationale into docs/adr/0001-machines-
     projects-workspace-model.md. This spec has settled to its durable framing
     (Problem / Solution / User Stories / Out of Scope). The design reference
     docs/plan-machines-and-init.md is superseded and may be deleted. -->

> Implementation + Testing decisions that were here now live in the tasks
> (`work/tasks/`); the durable architectural rationale (the two-mount invariant,
> the throwaway default, global-files/per-machine-conversations, forced egress,
> honest onboarding, the pure/impure split) lives in
> `docs/adr/0001-machines-projects-workspace-model.md`.

## Out of Scope

- **A fully-stateless "no host state at all" mode** (the old `--ephemeral`, which
  mounted NO writable home so pi wrote only to the container `--rm` layer).
  DROPPED for now: `--rm` is the throwaway default but STILL mounts the persistent
  machine home. If a truly homeless one-off is wanted later, it is a dedicated
  flag — capture as a `work/notes/ideas/` note if it resurfaces.
- **Baking an exploratory machine into an image.** No `anon-pi bake` verb and no
  dependency on a `netcage commit` verb. The exploratory `--keep` flow lets you
  re-enter a kept container via `netcage start`; turning that into a reusable
  image is out of scope for this spec (a user can run `podman commit` themselves).
  A `netcage commit` verb is staged separately in the netcage repo's backlog but
  is NOT a prerequisite here.
- **Concurrent second terminals into a running box** (a jail-aware `netcage exec`
  landing in an arbitrary cwd). Not needed: multiplexing happens INSIDE the box
  via the shell/tmux; anon-pi launches one entry point. A jail-aware `netcage
  exec` fidelity improvement is a separate netcage concern.
- **macOS/Windows native support.** Linux only (netcage's netns jail); unchanged.

## Further Notes

- netcage dependency: this builds ENTIRELY on netcage v0.4.0 as shipped (kept
  containers, `netcage start`, `--rm`, the `netcage.managed` label, management
  verbs). No netcage change is REQUIRED for this spec.
- The design reference `docs/plan-machines-and-init.md` is superseded by this spec
  + the tasks + ADR-0001 and may be deleted.

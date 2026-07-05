---
title: A `container` noun - explicit durable named boxes (create / enter / list / rm)
slug: container-noun
---

> Launch snapshot - records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked - they move into tasks/ADRs and this prd settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

## Problem Statement

ADR-0004 retired `--keep` and made every launch throwaway (`--rm`): durable state
is now image-based (`image snapshot` + `-i`, or a machine pinned to a snapshot
image). That is simpler, but it dropped ONE capability: a single durable jailed
box a user re-enters across sessions that ACCRETES uncommitted in-container
scratch (shell history, `/tmp`, a half-built tree) WITHOUT a snapshot step each
time. A machine pinned to a snapshot image gives a durable named environment, but
it runs a FRESH container each launch off a frozen image; it does not keep one
mutable instance alive. When the mutable-continuity workflow is what the user
wants, there is currently no clean way to get it.

The old `--keep` gave it, but by fusing two intents (create a fresh kept box /
re-enter the existing one) into one flag with INFERRED identity, which is exactly
why it could not tell "resume my box" from "give me a new one" (worsened once
`-i` made the image variable per launch). We want the capability back WITHOUT that
inference.

## Solution

Reintroduce durable mutable boxes as an EXPLICIT `container` noun, not a flag. The
user NAMES the container, so identity is explicit and there is no
resume-vs-fresh ambiguity. Two lifecycle verbs plus two housekeeping verbs:

```
anon-pi container create <name> -m <machine> [-i <image>] [--mount <p>] ...
    # instantiate a durable jailed box (netcage run WITHOUT --rm), pinned to its
    # creation-time image + home + cwd. Named. Listed. No inference.
anon-pi container enter <name>
    # re-enter it (netcage start) at its FROZEN cwd; NO -i (the image is fixed at
    # create) and NO project/--shell (the cwd is fixed at create too), so no
    # tag-moved and no which-cwd ambiguity ever arises. Refuses if already running.
anon-pi container list
anon-pi container rm <name>
```

`create` freezes the box's image at creation time; `enter` takes no `-i` at all
(nothing to override, nothing to silently ignore). Re-entering is BY NAME; a new
box is a NEW name. The whole string-vs-image-id keying dilemma that sank `--keep`
never arises.

This DELIBERATELY re-opens the ADR-0004 "throwaway always" drop, but only as an
explicit, named, opt-in path: the bare `anon-pi <project>` launch stays
throwaway; durable mutable continuity is now reachable ONLY through the
`container` noun, which the user names on purpose.

## User Stories

1. As a user doing exploratory system work, I want to `container create recon-box
   -m recon` once and get a durable jailed box, so that I can install packages and
   build scratch state that survives across sessions.
2. As a user, I want to `container enter recon-box` and be dropped back into that
   SAME box at its FROZEN cwd with its accreted state intact, so that I do not
   re-do setup each time.
3. As a user, I want the box's cwd (the project or `--shell`) FIXED at create
   time - `container create` takes the project/`--shell` mode word, `container
   enter` takes only the name and re-cwds there - so that a box has one stable
   identity (its cwd is also pi's conversation key) and "which cwd am I in" is
   never ambiguous; a different cwd is a different box (a new name).
4. As a user, I want the container's image FIXED at create time and `enter` to
   REFUSE (not silently accept) any `-i`, so that I can never think I switched the
   image and silently didn't.
5. As a user, I want `container create` to require an explicit `<name>` (never
   defaulted from the project), so that "resume my box" and "give me a new one" are
   never confused - a new name is a new box, full stop.
6. As a user, I want `container create <name>` to FAIL FAST if a container named
   `<name>` already exists, so that create never silently re-enters or clobbers.
7. As a user, I want `container list` to show my durable boxes with enough
   identity (name, machine, image, cwd/project, running-or-stopped), so that I can
   see what I have without inspecting netcage directly.
8. As a user, I want `container rm <name>` to remove a durable box, requiring
   `--yes` when the box is RUNNING (it stops-then-removes) and removing a stopped
   box directly, so that I never tear down a live box by accident; and I want it
   to refuse an unknown name rather than exit silently.
9. As a user, I want the box's image + home + cwd baked at create time to be the
   RECORD (read back off the netcage managed label / inspect, no anon-pi-side
   registry file), so that there is no separate state to drift or clean up.
10. As a user, I want `container` to compose with `-m` (picks the HOME) and
    `--mount` at CREATE, matching the launch grammar, so that a box's mounts and
    home are chosen exactly like a normal launch.
11. As a user, I want my pi conversations to live in the machine home as usual
    (pi keys by cwd; a named box still cwds into `/projects/<p>`), so that the
    container noun is about the FILESYSTEM instance only, orthogonal to home +
    conversations.
12. As a user, I want `container` to be a RESERVED noun word (like the existing
    verb nouns `machine` / `image`), so that a same-named project can never shadow
    the subcommand.
13. As a user, I want `forward` / `ports` to keep working against a running
    durable box (they resolve a RUNNING container via the `anon-pi.key` identity
    label, which every launch already stamps), so that host-port forwarding is
    unaffected by whether the container is throwaway or durable.

> **Tasked.** The go/no-go and the five shape decisions were resolved before
> tasking; the WHY (opt-in namespace with zero cost to non-users, mutable-instance
> continuity that snapshot + a pinned machine does not give, no create-vs-enter
> inference) is recorded in the container ADR under `docs/adr/` (which SUPERSEDES
> ADR-0004's "lost capability" note). The what-to-build detail (parse, durable
> run-plan, the four verbs, tests) lives in the tasks:
> `container-noun-parse-and-plan`, `container-create-enter`, `container-list-rm`.

## Out of Scope

- **The `--container <name>` launch shorthand** (create-or-enter in one call). It
  re-imports the create-vs-enter inference and the `-i`-silently-ignored footgun;
  captured with its shortcoming in
  `work/notes/ideas/container-flag-shorthand.md`. Only revisit if the two-step
  proves to be real daily friction.
- **A container prune / gc verb** beyond `rm` (add later if durable boxes
  accumulate in practice).
- **Cross-machine / clone-a-box operations** (copy a durable box, re-home it):
  out of scope; snapshot the box to an image instead.

## Further Notes

- The `container-create-flow.md` idea note is now discharged by this tasked prd +
  the container ADR: delete it once `container-noun-parse-and-plan` lands the ADR
  carrying its signal (the ADR must be self-contained, not a back-pointer).
- The `container-flag-shorthand.md` idea note is INDEPENDENT and survives (a
  possible future layer on top of this noun); do NOT delete it.

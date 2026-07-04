---
title: On-exit prompt to save a non---keep session as a new machine image
slug: save-image-on-exit
---

# Ask on exit: save this environment as a new machine?

Proposed idea (uncertain whether needed). Make `--rm` a POST-session decision
instead of a pre-session flag: for an interactive, non-`--keep` session, run the
netcage container WITHOUT `--rm`, and on exit ask the user whether to keep the
environment. If yes, commit it into a new image and create a machine for it
(prompting for the name); if no, remove the container (reproducing `--rm`, just
deferred to an interactive teardown).

## Why

The `machine snapshot` verb (see work/tasks/machine-snapshot-verb.md) covers the
"I did system work and I have not exited yet" case: you snapshot the LIVE
container. But it does not help the user who exits a default run and only THEN
realises they wanted to keep the apt installs, because `--rm` already destroyed
the layer. This idea closes that gap by deferring the `--rm` decision to exit,
so the user never has to preempt the choice with `--keep`.

In practice the snapshot verb may be enough: the realisation that "I want to keep
this" tends to come BEFORE leaving the container, and snapshot handles that. So
this on-exit prompt is a nice-to-have, not obviously necessary. Captured so the
option is not lost.

## Shape

- Interactive, non-`--keep` launch: compose the netcage `run` WITHOUT `--rm`
  (container survives exit).
- On exit, prompt (TTY only): `Save this environment as a new machine? [name/no]`.
- yes => `netcage commit <container> <image>`, `machine create <name>` pinned to
  it, then remove the container.
- no => `netcage rm <container>` (the deferred `--rm`).

## The hard parts (decide before building)

1. **Detecting meaningful change is hard.** A committed image ALWAYS differs from
   its base; `apt install` vs "pi wrote a file in /tmp" are indistinguishable at
   the layer level without heuristics. Options, increasing effort:
   - Do not detect: always ask (interactive only). Simplest, most honest; the
     user is the judge. Preferred starting point.
   - Cheap heuristic: `podman diff <container>` lists changed paths; skip the
     prompt when it is empty/trivial. Filters the "nothing happened" case.
   - Smarter (ignore /tmp, /var/log, ...) is a rabbit hole; the diff heuristic is
     the sweet spot.
2. **No-TTY / headless (`-p "..."`) must NEVER prompt** (it would hang): those
   keep hard `--rm`. The prompt is strictly interactive-session-only.
3. **Ctrl-C / crash paths.** An ungraceful exit leaves the container behind with
   no prompt run => a reaper story is needed (offer it on next launch, or a
   `machine gc`), else stopped containers accumulate. This is the one bit of
   lifecycle machinery this idea drags in.
4. **Forced-egress invariant.** The committed image carries the installed
   software, but the new machine relaunches through the same forced-egress jail
   (netcage owns the netns at run time), so commit cannot weaken egress. Confirm
   in an ADR line; no obvious hole.
5. **Home semantics.** Same as snapshot: the image is the system layer; the home
   is a separate host mount. A saved machine gets its own fresh home unless the
   user explicitly wants the source's config/convos copied.

## Relation to other work

- Builds on / overlaps `machine snapshot` (they share the commit + machine-create
  plumbing). Snapshot is the live-container path; this is the on-exit path.
- Changes the run LIFECYCLE (run without `--rm`, defer cleanup, add a crash
  reaper), so it deserves a grilling pass + an ADR before any code, unlike the
  snapshot verb which is a pure additive verb.

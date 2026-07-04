---
title: machine snapshot <machine> <new-name> — commit a running container into a new machine
slug: machine-snapshot-verb
prd: machines-and-projects-workspace
---

## What to build

A `machine snapshot` verb that captures the CURRENT filesystem of a machine's
RUNNING jailed container into a new image and registers a NEW machine pinned to
it. This lets a user do interactive system work in a session (e.g.
`sudo apt install <pkg>`), then, WITHOUT having pre-decided `--keep`, preserve
that exact environment as a recoverable machine, so long as they have not exited
(the default `--rm` deletes the container on exit; a live container is required).

```
anon-pi machine snapshot <machine> <new-name> [-m <machine>] [--image-tag <ref>]
```

- Resolve the ONE running anon-pi container for `<machine>` (reuse the
  `forward`/`ports` running-container resolution: `queryRunningContainers` +
  `resolveManagedMatches`, scoped by machine; 0 => error, 1 => it, many =>
  picker on a TTY).
- `netcage commit <container-ref> <image-ref>` to snapshot it (podman pauses the
  container during commit and unpauses, so the live session survives). The new
  image ref defaults to a generated tag (`anon-pi/<new-name>:snapshot-<ts>`);
  `--image-tag` overrides.
- `machine create <new-name>` pinned to that image (refuse to clobber an
  existing machine, exactly like `machine create`). The new machine gets its OWN
  FRESH home (seeded on first launch) — the image (system layer) and the home
  are orthogonal; snapshot preserves the SOFTWARE, not the conversations.

The pure module owns: the `snapshot` grammar in `parseMachineArgs`
(`{verb:'snapshot'; source:string; name:string; imageTag?:string}`, both names
validated via `validateName`) and the default image-tag derivation (a pure
`snapshotImageRef(name, now)` so it is testable). The CLI does the netcage
container resolution, the `netcage commit` spawn, and the `machine create` write.

Forced egress is untouched: `commit` is a local podman op (no egress), and the
snapshot machine relaunches through the SAME forced-egress jail (netcage owns
the netns at run time; an image cannot bake in a surviving network config).

## Acceptance criteria

- [ ] `anon-pi machine snapshot <machine> <new-name>` commits the machine's
      running container into a new image and creates `<new-name>` pinned to it;
      the new machine launches with the committed system layer intact.
- [ ] With no running container for `<machine>`: a clear error telling the user
      to start a session first (mirrors `forward`'s no-running-container message).
- [ ] Many running containers on the machine: an arrow-key picker on a TTY;
      non-TTY refuses and asks to narrow.
- [ ] Refuses to clobber an existing `<new-name>` machine (like `machine create`).
- [ ] The new machine's home is fresh (seeded on first launch); the source
      machine (its home + its live session) is UNTOUCHED.
- [ ] `netcage` missing => the shared `netcageMissing()` error (the verb needs it).
- [ ] The grammar parse + the default image-tag derivation are PURE + unit-tested
      (`parseMachineArgs` snapshot cases; `snapshotImageRef`); the CLI wiring is
      covered by a cli-level test with netcage stubbed (mirror the machine-verb
      test style).
- [ ] `MACHINE_HELP` + the top-level `--help` machine line document `snapshot`.
- [ ] A changeset (`minor`: a new user-facing verb) accompanies the change.

## Notes / decisions

- Requires a LIVE container: this does NOT recover a default run after exit (the
  container is already gone). The on-exit "save this environment?" prompt is a
  SEPARATE idea (see work/notes/ideas/save-image-on-exit.md) and is out of scope
  here.
- Home semantics: fresh home, not a copy of the source's. Rationale: snapshot is
  "keep the installed software," and the two axes (image, home) are deliberately
  orthogonal in the model. A "copy the home too" flag can be a later addition if
  wanted.
- Image tag lives in podman's local image store (like any `machine` image);
  cleanup of old snapshot images is the user's concern for v1 (a `machine rm`
  removes the machine dir, not the image, consistent with today's behaviour).

---
'anon-pi': minor
---

Implement the `container create` and `container enter` verb bodies (the durable
named box lifecycle from the container ADR / `container-noun-parse-and-plan`
foundation).

- `anon-pi container create <name> [-i <ref>] [-m <machine>] [--mount <p>]
  [<project>|--shell]` now instantiates a DURABLE jailed box: a `netcage run`
  WITHOUT `--rm` (so it survives exit), `--name`d and stamped with the
  `anon-pi.container=<name>` label. The image is FROZEN via the normal launch
  chain (`-i` > machine.json image > `ANON_PI_IMAGE`) and the cwd is FROZEN from
  the create-time mode word. `-m` picks the HOME and `--mount` composes exactly as
  a normal launch. Forced egress (the proxy + the one `--allow-direct`) and the
  two invariant mounts are intact: a durable box is still fully jailed. Creating a
  box whose name ALREADY exists FAILS FAST with a clear error (never a silent
  re-enter or clobber).
- `anon-pi container enter <name>` now re-enters a STOPPED box via `netcage start
  -it <ref>`, which re-stands the jail at the box's frozen cwd and re-supplies the
  forced egress (`start` stands the jail back up). An UNKNOWN name errors (never a
  silent success), and an already-RUNNING box is REFUSED with guidance (reach its
  in-jail servers via `forward` / `ports`, or `container rm` to reset it) rather
  than opening a second attach against the same filesystem.

Boxes are read back off the `anon-pi.container` netcage label (a new pure
`parseContainerBoxesJson` over `netcage ps -a --format json`), so there is no
anon-pi-side registry file: the label IS the record. `container list` / `rm` land
in a follow-up task.

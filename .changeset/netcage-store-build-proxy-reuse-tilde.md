---
'anon-pi': minor
---

Fix launches against netcage v0.7.0's private image store, expand `~` in paths,
reuse netcage's proxy scanner, and fully-qualify built image tags.

- **Build images into netcage's store.** Since netcage v0.7.0 every `netcage run`
  uses a private podman graphroot (`/var/tmp/netcage-storage`), not your default
  rootless store, so a plain `podman build` image was invisible to launches
  (podman tried to pull the `localhost/…` ref and failed — which looked like a
  hang). `init` now prefers `netcage build` when available, and otherwise builds
  with podman and loads the image into netcage's store. `resolveNetcageGraphroot`
  honours `NETCAGE_GRAPHROOT`.
- **Fully-qualified image tags.** `init` now tags built images
  `localhost/anon-pi/pi[-webveil]:latest` (podman refuses an unqualified short
  name at run time).
- **Expand `~` in host paths.** The `init` projects-root step and `--mount` now
  expand a leading `~`/`~/` to `$HOME` (`path.resolve` alone left a literal `~`
  dir), and config/env projects-root values are expanded too.
- **Reuse netcage's SOCKS scanner.** `init`'s proxy step uses `netcage
  detect-proxy --json` (its probe + SOCKS5 handshake + process hint) when
  available, falling back to anon-pi's own local probe; findings render through
  the same honest formatter (never labels the provider).
- **README** is now the repo-root `README.md` (source of truth), copied into the
  package at build/pack time.

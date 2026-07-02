# anon-pi

## 0.1.1

### Patch Changes

- 8ad9f14: Make the missing-`ANON_PI_IMAGE` error actionable: instead of a one-line dead
  end, it now prints a ready-to-build `Dockerfile.pi` recipe (the upstream pattern
  that installs `@earendil-works/pi-coding-agent`) plus the `podman build` and
  `export ANON_PI_IMAGE` commands, and points at the shipped `Dockerfile.pi` /
  README. `--help` gains a matching hint.

## 0.1.0

### Minor Changes

- e99c7cf: Initial release. anon-pi is a thin, opinionated launcher over `netcage run` that
  starts pi with all web/DNS egress forced through a socks5h proxy (fail-closed),
  one direct hole to a local model on the LAN, and a per-workdir seeded pi config
  on the host. Requires `netcage` on PATH and an `ANON_PI_IMAGE` with `pi` on it
  (a `Dockerfile.pi` is included).

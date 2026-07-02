---
'anon-pi': patch
---

Make the missing-`ANON_PI_IMAGE` error actionable: instead of a one-line dead
end, it now prints a ready-to-build `Dockerfile.pi` recipe (the upstream pattern
that installs `@earendil-works/pi-coding-agent`) plus the `podman build` and
`export ANON_PI_IMAGE` commands, and points at the shipped `Dockerfile.pi` /
README. `--help` gains a matching hint.

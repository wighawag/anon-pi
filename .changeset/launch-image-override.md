---
'anon-pi': minor
---

Add the ephemeral per-launch image override `-i <ref>` / `--image <ref>` to the
launch grammar (beside `-m`, `--shell`, `--mount`) (ADR-0003 §3).

`-i` is the highest-priority image source: `-i` > `machine.json.image` >
`ANON_PI_IMAGE` > error. It composes with `-m` (`-m` picks the HOME, `-i` picks
the IMAGE) and is STRICTLY EPHEMERAL: it NEVER mutates `machine.json` (to re-pin
a machine's image use `machine set-image` / `machine create --image`) and prints
NO mismatch warning (`-i` is explicit + ephemeral, so a warning carries no
information the user lacks).

On a FRESH (unseeded) machine home `-i` is REFUSED with guidance: seeding the
home from the ephemeral image would poison it with the wrong-image seed, so
anon-pi points at `anon-pi machine create <m> --image <ref>` (or a normal launch
to seed) instead. On an already-seeded home `-i` just runs the override image
against the existing home (the runtime extension-compat risk is accepted
silently, per ADR-0003).

`-i` resolves in NETCAGE'S private image store (where `anon-pi/<name>:latest`
snapshots and `init`-built images live), NOT the operator's default podman
store. anon-pi does NOT pre-check the ref and does NOT auto-pull (an anonymity
tool must not silently fetch a remote image); netcage/podman surfaces its own
"not found" via inherited stdio. The `--help` text documents this store boundary
so a "not found" is understood (fix: `image snapshot` it, or build it into
netcage's store).

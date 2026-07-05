---
'anon-pi': minor
---

Retire `--keep`/`--rm`: every launch is now throwaway (the container is always
`--rm`).

BREAKING: the `--keep` and `--rm` launch flags are removed. Passing either now
errors with guidance toward image-based persistence: snapshot the running
container into a named image (`anon-pi image snapshot <name>`) and pin a
machine to it (`anon-pi machine create <m> --image anon-pi/<name>:latest`). The exploratory
"apt install, quit, re-enter" pet-container flow (and the kept-container
run-vs-start inference behind it) is gone; durable state is explicit and named
instead of an inferred mutable container. Your pi config and conversations live
in the machine home (a host mount) and persist regardless.

`forward`, `ports`, and `image snapshot` are unchanged: anon-pi still stamps
its `anon-pi.key` identity label on every launch and reads it back to resolve a
running container by machine + project (the label survives; only the
kept-container matching was removed).

Per the ADR-0004 rollout, this ships as part of the combined 0.16.0 release
alongside the `image` noun and the `-i` launch override.

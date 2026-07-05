---
'anon-pi': minor
---

Add `anon-pi image snapshot <name> --update-machine <m>`: the mirror of
`--create-machine`, it commits the running container into `anon-pi/<name>:latest`
and RE-PINS an EXISTING machine `<m>` to the fresh snapshot in one step
(equivalent to `image snapshot` followed by `machine set-image`). The home is
left untouched; when `<m>` is the snapshot's own source machine the home already
matches the new image, so the `set-image` compatibility warning is suppressed
(re-pinning a different machine still warns).

`--create-machine` and `--update-machine` are mutually exclusive and each
fail-fast on the wrong existence state (`--create-machine` refuses an existing
name; `--update-machine` a missing one), so a mistyped name never silently
mutates a durable machine.

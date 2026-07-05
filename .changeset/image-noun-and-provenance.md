---
'anon-pi': minor
---

Introduce the top-level `image` noun and move snapshot onto it, with provenance
baked into the image as podman labels (ADR-0003 §1+2).

BREAKING: `machine snapshot` is renamed to `image snapshot` (a days-old verb).
`anon-pi image snapshot <name> [-m <machine>] [--create-machine <m>]` commits the
running container into the clean tag `anon-pi/<name>:latest` (a same-name
re-snapshot overwrites `:latest`; the previous image becomes dangling but keeps
its provenance). Provenance is baked via `netcage commit -c 'LABEL …'`:
`anon-pi.source-machine` (the committed container's machine), `anon-pi.source-image`
(read from the running container via inspect, so it is accurate even when `-i`
made the container's image diverge from the machine's pin; falls back to
`machine.json.image`, else the label is omitted), and `anon-pi.snapshot-at`.
Provenance is best-effort history, never a live pointer.

New `anon-pi image list`: read-only, zero stored state. Reads the provenance
labels straight off the images, surfacing every `anon-pi/*` image plus any
dangling image still carrying an `anon-pi.source-machine` label (an orphaned
snapshot whose `:latest` tag was overwritten), by its ID.

`machine create <name> --image <ref>` is now provenance-aware: if `<ref>` was
produced by `image snapshot` and its source machine's home still exists, the
home-copy (minus sessions) + per-project session carry-over are offered (the
same prompts the 0.15 snapshot ran). `image snapshot --create-machine <m>` is
the one-step convenience for the common path. Both share one
`carryOverHomeFromMachine` helper; both honor the no-TTY "copy nothing" rule.

Also: the subcommand noun words (`machine`, `image`, `init`, `forward`, `ports`)
are now reserved names, so a project/machine/image can no longer be named after a
dispatched verb (closing a latent "unreachable folder" trap). A pre-existing
project folder now reserved is silently skipped from the menu (never a crash),
and creating such a name is refused with a clear "reserved name" error.

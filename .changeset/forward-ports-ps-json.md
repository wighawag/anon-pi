---
'anon-pi': patch
---

Fix `forward`/`ports` (and `--keep` run-vs-start) container resolution: read
netcage's managed containers via `netcage ps --format json`.

The container lookup parsed `netcage ps` with a `{{.ID}}\t{{.Labels}}` Go
template, but netcage < 0.10.0 ignored `--format` and printed a fixed human
table with no Labels column, so anon-pi never found a running container:
`anon-pi forward` always reported "no running anon-pi container" (and `--keep`
always fell back to a fresh run instead of resuming). netcage 0.10.0 makes
`ps`/`inspect` forward podman's read-only output flags, so anon-pi now queries
`netcage ps --format json` and parses the structured `Labels` object (a robust
`parseNetcagePsJson`), decoding the `anon-pi.key` label to match the container.
`forward`/`ports` therefore require **netcage >= 0.10.0**.

Also: the "entering the netcage jail" status line no longer prints for
`forward` (it attaches to an existing jail, and prints its own "forwarding to …"
line); it stays on the launch paths (`run`/`start`) where the jail is set up.

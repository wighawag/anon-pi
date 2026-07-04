---
'anon-pi': minor
---

Add `anon-pi machine snapshot <machine> <new-name> [--image-tag <ref>]`: commit
the current filesystem of a machine's RUNNING jailed container into a new image
and create a new machine pinned to it. This lets you preserve an environment you
built interactively (e.g. after `sudo apt install`) WITHOUT having pre-decided
`--keep`, as long as the session is still running (the default `--rm` deletes
the container on exit). podman pauses the container briefly during the commit,
so the live session survives; the new machine gets a fresh home (the image is
the software, the home is a separate host mount) and relaunches through the same
forced-egress jail.

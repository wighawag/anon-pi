---
'anon-pi': minor
---

`machine snapshot` is now container-first: `anon-pi machine snapshot <new-name>
[-m <machine>] [--image-tag <ref>]`. The sole positional is the NEW machine
name; the running container to commit is auto-detected from the running anon-pi
containers (a picker when several are up), and `-m <machine>` is an OPTIONAL
narrowing filter, NOT a required source. This drops the awkward mandatory
source-machine positional from the initial 0.13.0 shape: what matters is the
container to snapshot, and the machine is only a filter, exactly as it is for
`forward`/`ports`.

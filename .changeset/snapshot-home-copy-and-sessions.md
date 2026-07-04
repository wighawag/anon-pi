---
'anon-pi': minor
---

`machine snapshot` now carries the source machine's HOME into the new machine
instead of leaving it fresh. The home is copied entirely EXCEPT its conversations
(config, extensions, downloaded tool binaries, dotfiles, the seed marker), which
is safe and preferable here because the new image IS the committed source
filesystem, so the copied extensions/binaries are correct for it (and the new
home is not re-seeded).

Conversations are handled deliberately: on a TTY you are offered each one grouped
BY PROJECT, opt-in per project (default SKIP), choosing COPY or SKIP for each
(with no TTY, none are copied, so scripted snapshots stay clean). COPY never
touches the source machine; after copying, a single confirmed step (default No)
can DELETE the copied groups from the source machine (the only way to "move" a
conversation out). This keeps the per-machine-history isolation intact: a
snapshot does not silently inherit the source machine's whole history.
